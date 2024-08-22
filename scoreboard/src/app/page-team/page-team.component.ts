import {Component, ElementRef, OnDestroy, OnInit, ViewChild} from '@angular/core';
import {ActivatedRoute} from "@angular/router";
import {interval, combineLatest, Subject, Subscription} from "rxjs";
import {BackendService} from "../backend.service";
import {Rank, RoundInformation} from "../models";
import {UiService} from "../ui.service";
import {KeyValue} from "@angular/common";
import {Chart, ChartData, ChartDataset, ChartOptions} from "chart.js";
import colorLib from "@kurkle/color";
import {BaseChartDirective} from "ng2-charts";


// Get color schemes from: https://github.com/nagix/chartjs-plugin-colorschemes/blob/master/src/colorschemes/colorschemes.tableau.js
// Or from here: https://vis4.net/palettes
// const COLORS = ['#4dc9f6', '#f67019', '#f53794', '#537bc4', '#acc236', '#166a8f', '#00a950', '#58595b', '#8549ba'];
// const COLORS = ['#4E79A7', '#A0CBE8', '#F28E2B', '#FFBE7D', '#59A14F', '#8CD17D', '#B6992D', '#F1CE63', '#499894', '#86BCB6', '#E15759', '#FF9D9A', '#79706E', '#BAB0AC', '#D37295', '#FABFD2', '#B07AA1', '#D4A6C8', '#9D7660', '#D7B5A6'];
const COLORS_LIGHT = ['#000', '#d62728', '#4e9f50', '#87d180', '#fcc66d', '#3ca8bc', '#98d9e4', '#94a323', '#c3ce3d', '#a08400', '#f7d42a', '#26897e', '#8dbfa8'];
// const COLORS_DARK = ['#fff', '#d62728', '#4e9f50', '#87d180', '#fcc66d', '#3ca8bc', '#98d9e4', '#94a323', '#c3ce3d', '#a08400', '#f7d42a', '#26897e', '#8dbfa8'];
const COLORS_DARK = ['#fff', '#d62728', '#2a5c44', '#48856d', '#6eb098', '#a2dcc2', '#ffffe0', '#dfc9e2', '#b997d6', '#906bb4', '#654a6c'];
let COLORS = COLORS_LIGHT;

function addScheme(obj, idx: number, lineonly = false): ChartDataset {
	let color = COLORS[idx];
	obj.colorIndex = idx;
	obj.hoverBorderColor = obj.borderColor = obj.pointHoverBorderColor = color;
	if (lineonly) {
		obj.pointBackgroundColor = obj.hoverBackgroundColor = obj.backgroundColor = '#0000';
		obj.pointBackgroundColor = obj.borderColor;
	} else {
		// obj.pointBackgroundColor = obj.hoverBackgroundColor = obj.backgroundColor = colorLib(color).alpha(0.5).rgbString();
		if (COLORS == COLORS_DARK) {
			obj.hoverBorderColor = obj.borderColor = obj.pointHoverBorderColor = colorLib(color).darken(0.1).rgbString();
			obj.pointBackgroundColor = obj.hoverBackgroundColor = obj.backgroundColor = color;
		} else {
			obj.pointBackgroundColor = obj.hoverBackgroundColor = obj.backgroundColor = colorLib(color).lighten(0.2).rgbString();
		}
	}
	// obj.pointBorderColor = obj.pointHoverBackgroundColor = '#fff';
	obj.pointBorderColor = obj.pointHoverBackgroundColor = obj.backgroundColor; // colorLib(color).lighten(0.2).rgbString();
	return obj;
}


@Component({
	selector: 'app-page-team',
	templateUrl: './page-team.component.html',
	styleUrls: ['./page-team.component.less']
})
export class PageTeamComponent implements OnInit, OnDestroy {

	public teamId: number = null;
	public currentTick: number = null;
	public currentRoundInfo: RoundInformation = null;
	public tickInfos: { [key: number]: Rank } = {};
	public tickInfosLength: number = 0;
	public numResults: number = 7;
	public loading: number = 0;

	// the team behind this one
	private dataAfterUs = addScheme({data: [], label: "team1", fill: false, pointRadius: 0, stack: '0', borderDash: [5, 5]}, 0, true);
	// the team before this one
	private dataBeforeUs = addScheme({data: [], label: "team3", fill: false, pointRadius: 0, stack: '1', borderDash: [10, 5]}, 1, true);
	public chartData: ChartData = {
		datasets: [],
		labels: []
	};
	public chartOptions: ChartOptions = {
		maintainAspectRatio: false,
		responsive: true,
		interaction: {
			mode: 'nearest',
			axis: 'x',
			intersect: false
		},
		scales: {
			y: {stacked: true, min: 0},
		},
	};
	@ViewChild(BaseChartDirective) chart?: BaseChartDirective;

	@ViewChild('loadMoreSpinner', { static: true }) loadMoreSpinner:ElementRef;

	private newestScoreboardTickSubscription: Subscription;
	private darkmodeSubscription: Subscription;
	private loadMoreSpinnerSubscription: Subscription;

	constructor(public backend: BackendService, public ui: UiService, private route: ActivatedRoute) {
		if (ui.darkmode)
			this.setGraphDarkMode(true);
	}

	ngOnInit(): void {
		this.route.paramMap.subscribe(map => {
			this.teamId = parseInt(map.get('teamid'));
			this.tickInfos = {};
			this.tickInfosLength = 0;
			this.numResults = 7;
			if (this.currentTick !== null) {
				this.fetchRoundInfos(this.numResults, true);
			}
		});
		this.newestScoreboardTickSubscription = this.backend.newestScoreboardTick.subscribe(tick => {
			this.setCurrentTick(tick);
		});
		this.darkmodeSubscription = this.ui.darkmodeChanges.subscribe(darkmode => this.setGraphDarkMode(darkmode));

		let isSpinnerShowing = new Subject();
		let observer = new IntersectionObserver(entries => {
			entries.forEach(entry => {
				isSpinnerShowing.next(entry.isIntersecting);
			});
		});
		observer.observe(this.loadMoreSpinner.nativeElement);

		this.loadMoreSpinnerSubscription =
			combineLatest([interval(500), isSpinnerShowing]).subscribe(([_, isShowing]) => {
				if (isShowing && this.loading == 0) {
					this.loadMore();
					if (document.scrollingElement.clientHeight + document.scrollingElement.scrollTop
						== document.scrollingElement.scrollHeight) {
						// prevent staying completely scrolled down
						document.scrollingElement.scrollBy(0, -1);
					}
				}
			});
		this.loadMoreSpinnerSubscription.add(() => observer.disconnect());
	}

	ngOnDestroy() {
		this.newestScoreboardTickSubscription.unsubscribe();
		this.darkmodeSubscription.unsubscribe();
		this.loadMoreSpinnerSubscription.unsubscribe();
	}

	setCurrentTick(tick: number) {
		this.currentTick = tick;
		if (tick >= 0 || tick == -1) {
			this.loading++;
			this.backend.getRanking(tick).subscribe(roundinfo => {
				this.loading--;
				this.currentRoundInfo = roundinfo;
				if (tick >= 0) {
					this.addRoundInfo(roundinfo);
					this.fetchRoundInfos(this.numResults, true);
				} else {
					this.updateGraph();
				}
			});
		}
	}

	addRoundInfo(ri: RoundInformation) {
		for (let rank of ri.scoreboard) {
			if (rank.team_id == this.teamId) {
				this.tickInfos[ri.tick] = rank;
				this.tickInfosLength = Object.keys(this.tickInfos).length;
				break;
			}
		}
	}

	fetchRoundInfos(count: number, updateGraph = false) {
		for (let i = this.currentTick; i > this.currentTick - count; i--) {
			if (i >= 0 && !this.tickInfos[i]) {
				this.loading++;
				this.backend.getRanking(i).subscribe(ri => {
					this.addRoundInfo(ri);
					this.loading--;
					if (updateGraph && ri.tick == this.currentTick)
						this.updateGraph();
				});
			} else if (updateGraph && i == this.currentTick) {
				this.updateGraph();
			}
		}
	}

	keyTrackBy(index, item: KeyValue<number, Rank>) {
		return item.key;
	}

	keyDescOrder = (a: KeyValue<string, Rank>, b: KeyValue<string, Rank>): number => {
		let keyA = parseInt(a.key);
		let keyB = parseInt(b.key);
		return keyA > keyB ? -1 : (keyB > keyA ? 1 : 0);
	}

	floatToString(n: number, zeroIsNegative = false): string {
		if (zeroIsNegative) {
			return (n > 0 ? '+' : (n === 0.0 ? '-' : '')) + n.toFixed(1);
		}
		return (n < 0 ? '' : '+') + n.toFixed(1);
	}

	loadMore() {
		this.numResults += 7;
		this.fetchRoundInfos(this.numResults);
	}

	updateGraph() {
		if (this.currentRoundInfo.tick < 0)
			return;
		// Get team before/after
		let teamAfterUs: number = null;
		let teamBeforeUs: number = null;
		for (let i = 0; i < this.currentRoundInfo.scoreboard.length; i++) {
			if (this.currentRoundInfo.scoreboard[i].team_id == this.teamId) {
				if (i > 0)
					teamBeforeUs = this.currentRoundInfo.scoreboard[i - 1].team_id;
				if (i + 1 < this.currentRoundInfo.scoreboard.length)
					teamAfterUs = this.currentRoundInfo.scoreboard[i + 1].team_id;
				break;
			}
		}
		// Update other team series
		let pos = 0;
		if (teamBeforeUs !== null) {
			if (this.chartData.datasets.length <= pos || this.chartData.datasets[pos] != this.dataBeforeUs) {
				this.chartData.datasets.splice(pos, 0, this.dataBeforeUs);
			}
			let beforePos = pos;
			this.backend.getTeamPointHistorySimple(teamBeforeUs).subscribe(points => {
				this.chartData.datasets[beforePos].data = points;
				this.chart?.update();
			});
			this.chartData.datasets[pos].label = 'Team ' + this.backend.teams[teamBeforeUs].name;
			pos++;
		} else if (this.chartData.datasets.length > pos && this.chartData.datasets[pos] == this.dataBeforeUs) {
			this.chartData.datasets.splice(pos, 1);
		}
		if (teamAfterUs !== null) {
			if (this.chartData.datasets.length <= pos || this.chartData.datasets[pos] != this.dataAfterUs) {
				this.chartData.datasets.splice(pos, 0, this.dataAfterUs);
			}
			let afterPos = pos;
			this.backend.getTeamPointHistorySimple(teamAfterUs).subscribe(points => {
				this.chartData.datasets[afterPos].data = points;
				this.chart?.update();
			});
			this.chartData.datasets[pos].label = 'Team ' + this.backend.teams[teamAfterUs].name;
			pos++;
		} else if (this.chartData.datasets.length > pos && this.chartData.datasets[pos] == this.dataAfterUs) {
			this.chartData.datasets.splice(pos, 1);
		}

		// Update service series
		let serviceOffset = pos;
		for (let i = 0; i < this.currentRoundInfo.services.length; i++) {
			if (this.chartData.datasets.length <= pos) {
				this.chartData.datasets.push(addScheme({
					data: [], label: this.currentRoundInfo.services[i].name,
					fill: true, pointRadius: 0
				}, (i % (COLORS.length - 2)) + 2));
			} else {
				this.chartData.datasets[pos].label = this.currentRoundInfo.services[i].name;
			}
			pos++;
		}
		while (this.chartData.datasets.length > pos) {
			this.chartData.datasets.pop();
		}
		while (this.chartData.labels.length <= this.currentTick) {
			this.chartData.labels.push(this.chartData.labels.length);
		}

		// Get the necessary data
		this.backend.getTeamPointHistory(this.teamId).subscribe(points => {
			for (let i = 0; i < points.length; i++) {
				this.chartData.datasets[i + serviceOffset].data = points[i];
			}
			this.chart?.update();
		});
	}

	setGraphDarkMode(dark: boolean) {
		if (dark) {
			Chart.defaults.color = '#ddd';
			COLORS = COLORS_DARK;
		} else {
			Chart.defaults.color = '#666';
			COLORS = COLORS_LIGHT;
		}
		this.chartOptions.color = Chart.defaults.color;
		// this.chartOptions.plugins.legend.labels.color = Chart.defaults.color;
		// this.chartOptions.scales.x.ticks.color = Chart.defaults.color;
		// this.chartOptions.scales.y.ticks.color = Chart.defaults.color;
		addScheme(this.dataAfterUs, 0, true);
		addScheme(this.dataBeforeUs, 1, true);
		for (let ds of this.chartData.datasets) {
			if (ds['colorIndex'] > 1)
				addScheme(ds, ds['colorIndex'], false);
		}
		this.chartOptions = {...this.chartOptions};
		this.chart?.update(0);
	}

	/*
	ColorSchemes = {
		Tableau10: ['#4E79A7', '#F28E2B', '#E15759', '#76B7B2', '#59A14F', '#EDC948', '#B07AA1', '#FF9DA7', '#9C755F', '#BAB0AC'],
		Tableau20: ['#4E79A7', '#A0CBE8', '#F28E2B', '#FFBE7D', '#59A14F', '#8CD17D', '#B6992D', '#F1CE63', '#499894', '#86BCB6', '#E15759', '#FF9D9A', '#79706E', '#BAB0AC', '#D37295', '#FABFD2', '#B07AA1', '#D4A6C8', '#9D7660', '#D7B5A6'],
		ColorBlind10: ['#1170aa', '#fc7d0b', '#a3acb9', '#57606c', '#5fa2ce', '#c85200', '#7b848f', '#a3cce9', '#ffbc79', '#c8d0d9'],
		SeattleGrays5: ['#767f8b', '#b3b7b8', '#5c6068', '#d3d3d3', '#989ca3'],
		Traffic9: ['#b60a1c', '#e39802', '#309143', '#e03531', '#f0bd27', '#51b364', '#ff684c', '#ffda66', '#8ace7e'],
		MillerStone11: ['#4f6980', '#849db1', '#a2ceaa', '#638b66', '#bfbb60', '#f47942', '#fbb04e', '#b66353', '#d7ce9f', '#b9aa97', '#7e756d'],
		SuperfishelStone10: ['#6388b4', '#ffae34', '#ef6f6a', '#8cc2ca', '#55ad89', '#c3bc3f', '#bb7693', '#baa094', '#a9b5ae', '#767676'],
		NurielStone9: ['#8175aa', '#6fb899', '#31a1b3', '#ccb22b', '#a39fc9', '#94d0c0', '#959c9e', '#027b8e', '#9f8f12'],
		JewelBright9: ['#eb1e2c', '#fd6f30', '#f9a729', '#f9d23c', '#5fbb68', '#64cdcc', '#91dcea', '#a4a4d5', '#bbc9e5'],
		Summer8: ['#bfb202', '#b9ca5d', '#cf3e53', '#f1788d', '#00a2b3', '#97cfd0', '#f3a546', '#f7c480'],
		Winter10: ['#90728f', '#b9a0b4', '#9d983d', '#cecb76', '#e15759', '#ff9888', '#6b6b6b', '#bab2ae', '#aa8780', '#dab6af'],
		GreenOrangeTeal12: ['#4e9f50', '#87d180', '#ef8a0c', '#fcc66d', '#3ca8bc', '#98d9e4', '#94a323', '#c3ce3d', '#a08400', '#f7d42a', '#26897e', '#8dbfa8'],
		RedBlueBrown12: ['#466f9d', '#91b3d7', '#ed444a', '#feb5a2', '#9d7660', '#d7b5a6', '#3896c4', '#a0d4ee', '#ba7e45', '#39b87f', '#c8133b', '#ea8783'],
		PurplePinkGray12: ['#8074a8', '#c6c1f0', '#c46487', '#ffbed1', '#9c9290', '#c5bfbe', '#9b93c9', '#ddb5d5', '#7c7270', '#f498b6', '#b173a0', '#c799bc'],
		HueCircle19: ['#1ba3c6', '#2cb5c0', '#30bcad', '#21B087', '#33a65c', '#57a337', '#a2b627', '#d5bb21', '#f8b620', '#f89217', '#f06719', '#e03426', '#f64971', '#fc719e', '#eb73b3', '#ce69be', '#a26dc2', '#7873c0', '#4f7cba'],
		OrangeBlue7: ['#9e3d22', '#d45b21', '#f69035', '#d9d5c9', '#77acd3', '#4f81af', '#2b5c8a'],
		RedGreen7: ['#a3123a', '#e33f43', '#f8816b', '#ced7c3', '#73ba67', '#44914e', '#24693d'],
		GreenBlue7: ['#24693d', '#45934d', '#75bc69', '#c9dad2', '#77a9cf', '#4e7fab', '#2a5783'],
		RedBlue7: ['#a90c38', '#e03b42', '#f87f69', '#dfd4d1', '#7eaed3', '#5383af', '#2e5a87'],
		RedBlack7: ['#ae123a', '#e33e43', '#f8816b', '#d9d9d9', '#a0a7a8', '#707c83', '#49525e'],
		GoldPurple7: ['#ad9024', '#c1a33b', '#d4b95e', '#e3d8cf', '#d4a3c3', '#c189b0', '#ac7299'],
		RedGreenGold7: ['#be2a3e', '#e25f48', '#f88f4d', '#f4d166', '#90b960', '#4b9b5f', '#22763f'],
		SunsetSunrise7: ['#33608c', '#9768a5', '#e7718a', '#f6ba57', '#ed7846', '#d54c45', '#b81840'],
		OrangeBlueWhite7: ['#9e3d22', '#e36621', '#fcad52', '#ffffff', '#95c5e1', '#5b8fbc', '#2b5c8a'],
		RedGreenWhite7: ['#ae123a', '#ee574d', '#fdac9e', '#ffffff', '#91d183', '#539e52', '#24693d'],
		GreenBlueWhite7: ['#24693d', '#529c51', '#8fd180', '#ffffff', '#95c1dd', '#598ab5', '#2a5783'],
		RedBlueWhite7: ['#a90c38', '#ec534b', '#feaa9a', '#ffffff', '#9ac4e1', '#5c8db8', '#2e5a87'],
		RedBlackWhite7: ['#ae123a', '#ee574d', '#fdac9d', '#ffffff', '#bdc0bf', '#7d888d', '#49525e'],
		OrangeBlueLight7: ['#ffcc9e', '#f9d4b6', '#f0dccd', '#e5e5e5', '#dae1ea', '#cfdcef', '#c4d8f3'],
		Temperature7: ['#529985', '#6c9e6e', '#99b059', '#dbcf47', '#ebc24b', '#e3a14f', '#c26b51'],
		BlueGreen7: ['#feffd9', '#f2fabf', '#dff3b2', '#c4eab1', '#94d6b7', '#69c5be', '#41b7c4'],
		BlueLight7: ['#e5e5e5', '#e0e3e8', '#dbe1ea', '#d5dfec', '#d0dcef', '#cadaf1', '#c4d8f3'],
		OrangeLight7: ['#e5e5e5', '#ebe1d9', '#f0ddcd', '#f5d9c2', '#f9d4b6', '#fdd0aa', '#ffcc9e'],
		Blue20: ['#b9ddf1', '#afd6ed', '#a5cfe9', '#9bc7e4', '#92c0df', '#89b8da', '#80b0d5', '#79aacf', '#72a3c9', '#6a9bc3', '#6394be', '#5b8cb8', '#5485b2', '#4e7fac', '#4878a6', '#437a9f', '#3d6a98', '#376491', '#305d8a', '#2a5783'],
		Orange20: ['#ffc685', '#fcbe75', '#f9b665', '#f7ae54', '#f5a645', '#f59c3c', '#f49234', '#f2882d', '#f07e27', '#ee7422', '#e96b20', '#e36420', '#db5e20', '#d25921', '#ca5422', '#c14f22', '#b84b23', '#af4623', '#a64122', '#9e3d22'],
		Green20: ['#b3e0a6', '#a5db96', '#98d687', '#8ed07f', '#85ca77', '#7dc370', '#75bc69', '#6eb663', '#67af5c', '#61a956', '#59a253', '#519c51', '#49964f', '#428f4d', '#398949', '#308344', '#2b7c40', '#27763d', '#256f3d', '#24693d'],
		Red20: ['#ffbeb2', '#feb4a6', '#fdab9b', '#fca290', '#fb9984', '#fa8f79', '#f9856e', '#f77b66', '#f5715d', '#f36754', '#f05c4d', '#ec5049', '#e74545', '#e13b42', '#da323f', '#d3293d', '#ca223c', '#c11a3b', '#b8163a', '#ae123a'],
		Purple20: ['#eec9e5', '#eac1df', '#e6b9d9', '#e0b2d2', '#daabcb', '#d5a4c4', '#cf9dbe', '#ca96b8', '#c48fb2', '#be89ac', '#b882a6', '#b27ba1', '#aa759d', '#a27099', '#9a6a96', '#926591', '#8c5f86', '#865986', '#81537f', '#7c4d79'],
		Brown20: ['#eedbbd', '#ecd2ad', '#ebc994', '#eac085', '#e8b777', '#e5ae6c', '#e2a562', '#de9d5a', '#d99455', '#d38c54', '#ce8451', '#c9784d', '#c47247', '#c16941', '#bd6036', '#b85636', '#b34d34', '#ad4433', '#a63d32', '#9f3632'],
		Gray20: ['#d5d5d5', '#cdcecd', '#c5c7c6', '#bcbfbe', '#b4b7b7', '#acb0b1', '#a4a9ab', '#9ca3a4', '#939c9e', '#8b9598', '#848e93', '#7c878d', '#758087', '#6e7a81', '#67737c', '#616c77', '#5b6570', '#555f6a', '#4f5864', '#49525e'],
		GrayWarm20: ['#dcd4d0', '#d4ccc8', '#cdc4c0', '#c5bdb9', '#beb6b2', '#b7afab', '#b0a7a4', '#a9a09d', '#a29996', '#9b938f', '#948c88', '#8d8481', '#867e7b', '#807774', '#79706e', '#736967', '#6c6260', '#665c51', '#5f5654', '#59504e'],
		BlueTeal20: ['#bce4d8', '#aedcd5', '#a1d5d2', '#95cecf', '#89c8cc', '#7ec1ca', '#72bac6', '#66b2c2', '#59acbe', '#4ba5ba', '#419eb6', '#3b96b2', '#358ead', '#3586a7', '#347ea1', '#32779b', '#316f96', '#2f6790', '#2d608a', '#2c5985'],
		OrangeGold20: ['#f4d166', '#f6c760', '#f8bc58', '#f8b252', '#f7a84a', '#f69e41', '#f49538', '#f38b2f', '#f28026', '#f0751e', '#eb6c1c', '#e4641e', '#de5d1f', '#d75521', '#cf4f22', '#c64a22', '#bc4623', '#b24223', '#a83e24', '#9e3a26'],
		GreenGold20: ['#f4d166', '#e3cd62', '#d3c95f', '#c3c55d', '#b2c25b', '#a3bd5a', '#93b958', '#84b457', '#76af56', '#67a956', '#5aa355', '#4f9e53', '#479751', '#40914f', '#3a8a4d', '#34844a', '#2d7d45', '#257740', '#1c713b', '#146c36'],
		RedGold21: ['#f4d166', '#f5c75f', '#f6bc58', '#f7b254', '#f9a750', '#fa9d4f', '#fa9d4f', '#fb934d', '#f7894b', '#f47f4a', '#f0774a', '#eb6349', '#e66549', '#e15c48', '#dc5447', '#d64c45', '#d04344', '#ca3a42', '#c43141', '#bd273f', '#b71d3e'],
		Classic10: ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'],
		ClassicMedium10: ['#729ece', '#ff9e4a', '#67bf5c', '#ed665d', '#ad8bc9', '#a8786e', '#ed97ca', '#a2a2a2', '#cdcc5d', '#6dccda'],
		ClassicLight10: ['#aec7e8', '#ffbb78', '#98df8a', '#ff9896', '#c5b0d5', '#c49c94', '#f7b6d2', '#c7c7c7', '#dbdb8d', '#9edae5'],
		Classic20: ['#1f77b4', '#aec7e8', '#ff7f0e', '#ffbb78', '#2ca02c', '#98df8a', '#d62728', '#ff9896', '#9467bd', '#c5b0d5', '#8c564b', '#c49c94', '#e377c2', '#f7b6d2', '#7f7f7f', '#c7c7c7', '#bcbd22', '#dbdb8d', '#17becf', '#9edae5'],
		ClassicGray5: ['#60636a', '#a5acaf', '#414451', '#8f8782', '#cfcfcf'],
		ClassicColorBlind10: ['#006ba4', '#ff800e', '#ababab', '#595959', '#5f9ed1', '#c85200', '#898989', '#a2c8ec', '#ffbc79', '#cfcfcf'],
		ClassicTrafficLight9: ['#b10318', '#dba13a', '#309343', '#d82526', '#ffc156', '#69b764', '#f26c64', '#ffdd71', '#9fcd99'],
		ClassicPurpleGray6: ['#7b66d2', '#dc5fbd', '#94917b', '#995688', '#d098ee', '#d7d5c5'],
		ClassicPurpleGray12: ['#7b66d2', '#a699e8', '#dc5fbd', '#ffc0da', '#5f5a41', '#b4b19b', '#995688', '#d898ba', '#ab6ad5', '#d098ee', '#8b7c6e', '#dbd4c5'],
		ClassicGreenOrange6: ['#32a251', '#ff7f0f', '#3cb7cc', '#ffd94a', '#39737c', '#b85a0d'],
		ClassicGreenOrange12: ['#32a251', '#acd98d', '#ff7f0f', '#ffb977', '#3cb7cc', '#98d9e4', '#b85a0d', '#ffd94a', '#39737c', '#86b4a9', '#82853b', '#ccc94d'],
		ClassicBlueRed6: ['#2c69b0', '#f02720', '#ac613c', '#6ba3d6', '#ea6b73', '#e9c39b'],
		ClassicBlueRed12: ['#2c69b0', '#b5c8e2', '#f02720', '#ffb6b0', '#ac613c', '#e9c39b', '#6ba3d6', '#b5dffd', '#ac8763', '#ddc9b4', '#bd0a36', '#f4737a'],
		ClassicCyclic13: ['#1f83b4', '#12a2a8', '#2ca030', '#78a641', '#bcbd22', '#ffbf50', '#ffaa0e', '#ff7f0e', '#d63a3a', '#c7519c', '#ba43b4', '#8a60b0', '#6f63bb'],
		ClassicGreen7: ['#bccfb4', '#94bb83', '#69a761', '#339444', '#27823b', '#1a7232', '#09622a'],
		ClassicGray13: ['#c3c3c3', '#b2b2b2', '#a2a2a2', '#929292', '#838383', '#747474', '#666666', '#585858', '#4b4b4b', '#3f3f3f', '#333333', '#282828', '#1e1e1e'],
		ClassicBlue7: ['#b4d4da', '#7bc8e2', '#67add4', '#3a87b7', '#1c73b1', '#1c5998', '#26456e'],
		ClassicRed9: ['#eac0bd', '#f89a90', '#f57667', '#e35745', '#d8392c', '#cf1719', '#c21417', '#b10c1d', '#9c0824'],
		ClassicOrange7: ['#f0c294', '#fdab67', '#fd8938', '#f06511', '#d74401', '#a33202', '#7b3014'],
		ClassicAreaRed11: ['#f5cac7', '#fbb3ab', '#fd9c8f', '#fe8b7a', '#fd7864', '#f46b55', '#ea5e45', '#e04e35', '#d43e25', '#c92b14', '#bd1100'],
		ClassicAreaGreen11: ['#dbe8b4', '#c3e394', '#acdc7a', '#9ad26d', '#8ac765', '#7abc5f', '#6cae59', '#60a24d', '#569735', '#4a8c1c', '#3c8200'],
		ClassicAreaBrown11: ['#f3e0c2', '#f6d29c', '#f7c577', '#f0b763', '#e4aa63', '#d89c63', '#cc8f63', '#c08262', '#bb7359', '#bb6348', '#bb5137'],
		ClassicRedGreen11: ['#9c0824', '#bd1316', '#d11719', '#df513f', '#fc8375', '#cacaca', '#a2c18f', '#69a761', '#2f8e41', '#1e7735', '#09622a'],
		ClassicRedBlue11: ['#9c0824', '#bd1316', '#d11719', '#df513f', '#fc8375', '#cacaca', '#67add4', '#3a87b7', '#1c73b1', '#1c5998', '#26456e'],
		ClassicRedBlack11: ['#9c0824', '#bd1316', '#d11719', '#df513f', '#fc8375', '#cacaca', '#9b9b9b', '#777777', '#565656', '#383838', '#1e1e1e'],
		ClassicAreaRedGreen21: ['#bd1100', '#c82912', '#d23a21', '#dc4930', '#e6583e', '#ef654d', '#f7705b', '#fd7e6b', '#fe8e7e', '#fca294', '#e9dabe', '#c7e298', '#b1de7f', '#a0d571', '#90cb68', '#82c162', '#75b65d', '#69aa56', '#5ea049', '#559633', '#4a8c1c'],
		ClassicOrangeBlue13: ['#7b3014', '#a33202', '#d74401', '#f06511', '#fd8938', '#fdab67', '#cacaca', '#7bc8e2', '#67add4', '#3a87b7', '#1c73b1', '#1c5998', '#26456e'],
		ClassicGreenBlue11: ['#09622a', '#1e7735', '#2f8e41', '#69a761', '#a2c18f', '#cacaca', '#67add4', '#3a87b7', '#1c73b1', '#1c5998', '#26456e'],
		ClassicRedWhiteGreen11: ['#9c0824', '#b41f27', '#cc312b', '#e86753', '#fcb4a5', '#ffffff', '#b9d7b7', '#74af72', '#428f49', '#297839', '#09622a'],
		ClassicRedWhiteBlack11: ['#9c0824', '#b41f27', '#cc312b', '#e86753', '#fcb4a5', '#ffffff', '#bfbfbf', '#838383', '#575757', '#393939', '#1e1e1e'],
		ClassicOrangeWhiteBlue11: ['#7b3014', '#a84415', '#d85a13', '#fb8547', '#ffc2a1', '#ffffff', '#b7cde2', '#6a9ec5', '#3679a8', '#2e5f8a', '#26456e'],
		ClassicRedWhiteBlackLight10: ['#ffc2c5', '#ffd1d3', '#ffe0e1', '#fff0f0', '#ffffff', '#f3f3f3', '#e8e8e8', '#dddddd', '#d1d1d1', '#c6c6c6'],
		ClassicOrangeWhiteBlueLight11: ['#ffcc9e', '#ffd6b1', '#ffe0c5', '#ffead8', '#fff5eb', '#ffffff', '#f3f7fd', '#e8effa', '#dce8f8', '#d0e0f6', '#c4d8f3'],
		ClassicRedWhiteGreenLight11: ['#ffb2b6', '#ffc2c5', '#ffd1d3', '#ffe0e1', '#fff0f0', '#ffffff', '#f1faed', '#e3f5db', '#d5f0ca', '#c6ebb8', '#b7e6a7'],
		ClassicRedGreenLight11: ['#ffb2b6', '#fcbdc0', '#f8c7c9', '#f2d1d2', '#ecdbdc', '#e5e5e5', '#dde6d9', '#d4e6cc', '#cae6c0', '#c1e6b4', '#b7e6a7']
	};
	// */
}