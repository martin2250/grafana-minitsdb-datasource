///<reference path="../node_modules/grafana-sdk-mocks/app/headers/common.d.ts" />
import isEqual from 'lodash/isEqual';
import isObject from 'lodash/isObject';
import isUndefined from 'lodash/isUndefined';
import _ from 'lodash';

export class GenericDatasource {

	name: string;
	url: string;
	q: any;
	backendSrv: any;
	templateSrv: any;
	withCredentials: boolean;
	headers: any;

	/** @ngInject **/
	constructor(instanceSettings, $q, backendSrv, templateSrv) {
		this.name = instanceSettings.name;
		this.url = instanceSettings.url;
		this.q = $q;
		this.backendSrv = backendSrv;
		this.templateSrv = templateSrv;
		this.withCredentials = instanceSettings.withCredentials;
		this.headers = { 'Content-Type': 'application/json' };
		if (typeof instanceSettings.basicAuth === 'string' && instanceSettings.basicAuth.length > 0) {
			this.headers['Authorization'] = instanceSettings.basicAuth;
		}
	}

	query(options) {
		const query = options;
		options.scopedVars = { ...this.getVariables(), ...options.scopedVars };

		let text = query.targets[0].data;

		_.each(options.scopedVars, (val, key) => {
			val = val.value;
			if (key == '__from' || key == '__to') {
				val = Math.round(val / 1000);
			}
			text = text.replace('$' + key, val);
		});

		// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Typed_arrays
		return this.doRequest({
			url: `${this.url}/query`,
			data: text,
			method: 'POST',
			responseType: 'arraybuffer'
		}).then((response) => {
			console.log(response)
			let datau8 = new Uint8Array(response.data);
			let indexLast = 0;

			function readJson() {
				let index = datau8.indexOf(10, indexLast); // find newline

				if (index == -1) {
					return null
				}

				let str = new TextDecoder("utf-8").decode(datau8.subarray(indexLast, index));

				indexLast = index + 1;

				return JSON.parse(str);
			}

			function readInt64(length) {
				let subarray = response.data.slice(indexLast, indexLast + 8 * length);
				let subdata = new BigInt64Array(subarray);
				indexLast += 8 * length;
				return subdata;
			}

			function readFloat64(length) {
				let subarray = response.data.slice(indexLast, indexLast + 8 * length);
				let subdata = new Float64Array(subarray);
				indexLast += 8 * length;
				return subdata;
			}

			let series = readJson()
			let columns = [] as any[];
			let idx = 0;

			for (var s of series) {
				s.indices = [] as number[];

				for (var c of s['Columns']) {
					let target = "";
					if (query.targets[0].alias) {
						target = query.targets[0].alias;

						_.each(s['Tags'], (val, key) => {
							target = target.replace('${series.' + key + '}', val);
						});
						_.each(c, (val, key) => {
							target = target.replace('${column.' + key + '}', val);
						});

					} else {
						target = JSON.stringify({
							series: s['Tags'],
							column: c
						});
					}
					columns.push({
						target: target,
						datapoints: [] as any[][]
					});
					s.indices.push(idx++);
				}
			}

			while (indexLast < datau8.length) {
				let desc = readJson();
				let time = readInt64(desc.NumPoints);

				for (var i = 0; i < desc.NumValues; i++) {
					let values = readFloat64(desc.NumPoints);

					for (var j = 0; j < desc.NumPoints; j++) {
						columns[series[desc.SeriesIndex].indices[i]].datapoints.push([values[j], 1000*Number(time[j])])
					}
				}
			}

			console.log(columns);

			response.data = columns;
			return response;
		});
	}

	testDatasource() {
		return this.doRequest({
			url: `${this.url}/test`,
			method: 'GET',
		}).then((response) => {
			if (response.status === 200) {
		return { status: 'success', message: 'Data source is working', title: 'Success' };
			}

			return {
		status: 'error',
		message: `Data source is not working: ${response.message}`,
		title: 'Error',
			};
		});
	}

	annotationQuery(options) {
		const query = this.templateSrv.replace(options.annotation.query, {}, 'glob');

		const annotationQuery = {
			annotation: {
		query,
		name: options.annotation.name,
		datasource: options.annotation.datasource,
		enable: options.annotation.enable,
		iconColor: options.annotation.iconColor,
			},
			range: options.range,
			rangeRaw: options.rangeRaw,
			variables: this.getVariables(),
		};

		return this.doRequest({
			url: `${this.url}/annotations`,
			method: 'POST',
			data: annotationQuery,
		}).then((result) => {
			return result.data;
		});
	}

	metricFindQuery(query) {
		const interpolated = {
			target: this.templateSrv.replace(query, null, 'regex'),
		};

		return this.doRequest({
			url: `${this.url}/search`,
			data: interpolated,
			method: 'POST',
		}).then(this.mapToTextValue);
	}

	mapToTextValue(result) {
		return result.data.map((d, i) => {
			if (d && d.text && d.value) {
		return { text: d.text, value: d.value };
			}

			if (isObject(d)) {
		return { text: d, value: i };
			}
			return { text: d, value: d };
		});
	}

	doRequest(options) {
		options.withCredentials = this.withCredentials;
		options.headers = this.headers;

		return this.backendSrv.datasourceRequest(options);
	}

	buildQueryTargets(options) {
		return options.targets
			.filter((target) => {
		// remove placeholder targets
		return target.target !== 'select metric';
			})
			.map((target) => {
		const data = isUndefined(target.data) || target.data.trim() === ''
			? null
			: JSON.parse(target.data);

		if (data !== null) {
			Object.keys(data).forEach((key) => {
		const value = data[key];
		if (typeof value !== 'string') {
			return;
		}

		const matches = value.match(/\$([\w]+)/g);
		if (matches !== null) {
			if (matches.length > 1) {
		console.error(
			'Use ${var1} format to specify multiple variables in one value' +
			`so we can safely replace that. Passed value was "${value}".`,
		);
			} else {
		data[key] = this.cleanMatch(matches[0], options);

		return;
			}
		}

		const matchesWithBraces = value.match(/\${([\w-]+)}/g);
		if (matchesWithBraces !== null) {
			data[key] = value
		.replace(/\${([\w-]+)}/g, match => this.cleanMatch(match, options));
		}
			});
		}

		let targetValue = target.target;
		if (typeof targetValue === 'string') {
			targetValue = this.templateSrv.replace(
		target.target.toString(),
		options.scopedVars,
		'regex',
			);
		}

		return {
			data,
			target: targetValue,
			refId: target.refId,
			hide: target.hide,
			type: target.type,
		};
			});
	}

	cleanMatch(match, options) {
		const replacedMatch = this.templateSrv.replace(match, options.scopedVars, 'json');
		if (typeof replacedMatch === 'string') {
			return replacedMatch.substring(1, replacedMatch.length - 1);
		}
		return replacedMatch;
	}

	getVariables() {
		const index = isUndefined(this.templateSrv.index) ? {} : this.templateSrv.index;
		const variables = {};
		Object.keys(index).forEach((key) => {
			const variable = index[key];

			let variableValue = variable.current.value;
			if (variableValue === '$__all' || isEqual(variableValue, ['$__all'])) {
		if (variable.allValue === null) {
			variableValue = variable.options.slice(1).map(textValuePair => textValuePair.value);
		} else {
			variableValue = variable.allValue;
		}
			}

			variables[key] = {
		text: variable.current.text,
		value: variableValue,
			};
		});

		return variables;
	}

	getTagKeys(options) {
		return new Promise((resolve, reject) => {
			this.doRequest({
		url: `${this.url}/tag-keys`,
		method: 'POST',
		data: options,
			}).then((result) => {
		return resolve(result.data);
			});
		});
	}

	getTagValues(options) {
		return new Promise((resolve, reject) => {
			this.doRequest({
		url: `${this.url}/tag-values`,
		method: 'POST',
		data: options,
			}).then((result) => {
		return resolve(result.data);
			});
		});
	}

}
