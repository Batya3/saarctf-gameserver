#!/usr/bin/env python3
import os  # isort:skip
import sys  # isort:skip

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  #  NOQA

import re
import subprocess
import tempfile
import time
import typing as t
from pprint import pprint

import psycopg2
import pwnlib.context
import pwnlib.log
import requests
from pwnlib.tubes.process import process

from ci import ctf
from saarctf_commons.config import postgres_psycopg2

# Number of rounds we want the game to last
ROUND_COUNT = 7
# Time for a single round in seconds
ROUND_TIME = 5
LOG_LEVEL_IMPORTANT = 10
LOG_LEVEL_WARNING = 20

pwnlib.log.install_default_handler()
if "DEBUG" in os.environ:
    pwnlib.context.context.log_level = "DEBUG"


def hook() -> None:
    """
    Hook pwnlib process and store all the stdout communication in `stdout_all`
    """
    real_recv = process.recv_raw

    def recv(self: process, numb: int) -> bytes:
        data = real_recv(self, numb)
        # Sometimes the returned data is of type str
        # Accept them by converting them to bytes
        if type(data) == str:
            data = data.encode()
        try:
            stdout_all = self.stdout_all
        except Exception:  # pylint: disable=broad-except
            stdout_all = b""
        stdout_all += data
        self.stdout_all = stdout_all
        return data

    process.recv_raw = recv


def create_teams(conn: t.Any) -> None:
    cur = conn.cursor()
    cur.execute("DELETE FROM teams")
    cur.execute(
        "INSERT INTO teams (id, name, vpn_connected, vpn_last_connect) VALUES (%s, %s, %s, %s), (%s, %s, %s, %s)",
        (1, "NOP", False, None, 2, "🏁test🏁", True, "1970-01-01"),
    )
    conn.commit()


def create_services(conn: t.Any) -> None:
    cur = conn.cursor()
    cur.execute("DELETE FROM services")
    cur.execute(
        """INSERT INTO services(id, "name", checker_script, checker_timeout, checker_script_dir, checker_enabled, checker_subprocess) VALUES (%s, %s, %s, %s, %s, %s, %s)""",
        (
            1,
            "Worker",
            "checker_runner.demo_checker:WorkingService",
            2,
            None,
            True,
            False,
        ),
    )
    conn.commit()


def spawn_gamseserver_components() -> t.List[process]:
    # The readuntil blocks until the process is sucessfully spawned
    # The timout is necessary, it stderr is redirected to ensure that the readuntil does not block forever

    stderr = subprocess.STDOUT
    # Make output visible for debugging
    # stderr = 2

    flask = process(["flask", "run", "--host=0.0.0.0"], stderr=stderr)
    celery = process(
        ["celery", "-A", "checker_runner", "flower", "--port=5555"], stderr=stderr
    )
    celery_worker = process(
        [
            "celery",
            "-A",
            "checker_runner",
            "worker",
            "-Ofair",
            "-E",
            "-Q",
            "celery,broadcast",
            "--concurrency=8",
            "--hostname=ident@%h",
        ],
        stderr=stderr,
        # stdout must be a pipe, not a pty. but stderr must also be captured. pwntools can't do this, so we work around:
        stdout=subprocess.PIPE,
        preexec_fn=lambda: os.dup2(1, 2)
    )

    # Ensure all processes are started
    flask.readuntil(b"Master timer initialized", timeout=10)
    celery.readuntil(b"inspect method failed", timeout=10)
    celery_worker.readuntil(b"[queues]", timeout=10)

    return [flask, celery, celery_worker]


def check_log_messages(logs: t.List[t.Dict[str, t.Any]]) -> None:
    pprint(logs)

    # Ensure there are no warnings or errors in the log
    for entry in logs:
        if entry["level"] >= LOG_LEVEL_WARNING:
            raise Exception(f"Found warning or error in log: {entry}")

    def assert_title_in_logs(title: str) -> None:
        for entry in logs:
            if title in entry["title"]:
                return
        raise Exception(f"Could not find the title: '{title}'")

    def assert_title_count(title: str, count: int) -> None:
        occurences = 0
        for entry in logs:
            if title in entry["title"]:
                occurences += 1
        if occurences != count:
            raise Exception(
                f"Could not find the title often enough. Expected {count} but found {occurences}. Title: '{title}'"
            )

    assert_title_in_logs("CTF starts")
    assert_title_in_logs("Network open")
    # assert_title_in_logs("Network closed")
    assert_title_in_logs("Network open within teams only")  # after the game teams should retain access to their vulnbox
    assert_title_in_logs("CTF stopped")
    for i in range(ROUND_COUNT):
        assert_title_in_logs(f"New round: {i+1}")

    assert_title_count("Checker scripts dispatched", ROUND_COUNT)
    assert_title_count("Collected checker script results", ROUND_COUNT)
    assert_title_count("Ranking calculated", ROUND_COUNT)


def main() -> None:
    # Switch into the root of the project
    os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

    hook()

    # reset everything
    subprocess.run(["flask", "db", "upgrade"], check=True)
    subprocess.run(["python3", "./scripts/reset_ctf.py"], input=b"y", check=True)
    handles = spawn_gamseserver_components()

    logs = None

    try:
        conn = psycopg2.connect(postgres_psycopg2())
        create_teams(conn)
        create_services(conn)

        # Recreate scoreboard
        subprocess.run(["python3", "./scripts/recreate_scoreboard.py"], check=True)
        # set roundtime, end round, start ctf
        ctf.set_roundtime(ROUND_TIME)
        ctf.set_lastround(ROUND_COUNT)
        ctf.start_ctf()

        # wait until CTF is over
        time.sleep((ROUND_COUNT + 2) * ROUND_TIME)

        # Download logs and check for errors
        # ensure no errors in http://localhost:5000/overview/logs
        res = requests.get("http://localhost:5000/overview/logs/0")
        res.raise_for_status()
        logs = res.json()
        check_log_messages(logs)

        # check output of celery worker
        output = handles[2].recvall(timeout=1)
        # The ] is important, as there are also "stderr-Test-2" messages, which otherwise would also match
        count = len(re.findall(br"\] stderr-Test", output))
        if ROUND_COUNT != count:
            raise Exception(
                f"The celery worker executed the demo_checker {count} times, but we expect {ROUND_COUNT}"
            )

    except Exception as e:
        print("Captured logs from controlserver:")
        pprint(logs)

        for handle in handles:
            print(f"**Stdout/Stderr of process {handle.executable}**")
            print(handle.stdout_all.decode())
            print()

        raise e
    finally:
        # Close background processes
        for handle in handles:
            try:
                handle.recvall(timeout=1)
                handle.terminate()
                handle.wait(2)
                handle.kill()
                handle.wait(2)
            except Exception:
                pass


if __name__ == "__main__":
    main()
