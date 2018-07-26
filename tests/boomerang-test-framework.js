/*eslint-env mocha*/
/*global _*/

//
// BOOMR.plugins.TestFramework
//
(function(window) {

	// set our namespace
	var BOOMR = window.BOOMR = window.BOOMR || {};
	BOOMR.plugins = BOOMR.plugins || {};
	if (BOOMR.plugins.TestFramework) {
		return;
	}

	BOOMR.plugins.TestFramework = {
		initialized: false,
		fired_page_ready: false,
		fired_onbeacon: false,
		fired_before_unload: false,
		beacons: [],
		sendBeacons: [],
		page_ready: function() {
			this.fired_page_ready = true;
		},
		onbeacon: function(data) {
			this.beacons.push(_.clone(data));
			this.fired_onbeacon = true;
		},
		lastBeacon: function() {
			if (this.beacons.length === 0) {
				return false;
			}

			return this.beacons[this.beacons.length - 1];
		},
		beaconCount: function() {
			return this.beacons.length;
		},
		before_unload: function() {
			this.fired_before_unload = true;
		},
		init: function() {
			if (this.initialized) {
				return this;
			}

			BOOMR.subscribe("page_ready", this.page_ready, null, this);
			BOOMR.subscribe("beacon", this.onbeacon, null, this);
			BOOMR.subscribe("before_unload", this.before_unload, null, this);

			this.initialized = true;

			return this;
		},
		is_complete: function() {
			return true;
		}
	};

	(function() {
		var savedSendBeacon;
		if (window.navigator && typeof window.navigator.sendBeacon === "function") {
			savedSendBeacon = window.navigator.sendBeacon;
			window.navigator.sendBeacon = function(url, data) {
				var result = savedSendBeacon.apply(window.navigator, arguments);
				if (result) {
					var reader = new FileReader();
					reader.addEventListener("loadend", function() {
						BOOMR.plugins.TestFramework.sendBeacons.push(reader.result);
					});
					reader.readAsText(data);
				}
				return result;
			};
		}
	})();
})(window);

//
// BOOMR_test
//
(function(window) {
	"use strict";

	var t = {};

	var complete = false;
	var initialized = false;
	var testFailures = [];
	var testPasses = [];

	var beaconsSeen = 0;

	var doNotTestErrorsParam = false;

	// test framework
	var assert;

	//
	// Constants
	//
	t.BEACON_URL = "/beacon";
	t.MAX_RESOURCE_WAIT = 500;

	//
	// Exports
	//
	t.templates = {};

	t.isComplete = function() {
		return complete;
	};

	t.isInitialized = function() {
		return initialized;
	};

	t.getTestFailures = function() {
		return complete ? testFailures : [];
	};

	t.getTestFailureMessages = function() {
		if (!complete) {
			return "";
		}

		var messages = "";
		for (var i = 0; i < testFailures.length; i++) {
			messages += i > 0 ? "\n" : "";
			messages += testFailures[i].titles + ": " + testFailures[i].name + " | " + testFailures[i].message;
		}

		return messages;
	};

	t.getTestPasses = function() {
		return complete ? testPasses : [];
	};

	t.CONFIG_DEFAULTS = {
		beacon_url: t.BEACON_URL,
		ResourceTiming: {
			enabled: false
		},
		doNotTestErrorsParam: false
	};

	t.flattenTestTitles = function(test) {
		var titles = [];
		while (test.parent.title) {
			titles.push(test.parent.title);
			test = test.parent;
		}
		return titles.reverse();
	};

	t.runTests = function() {
		var runner = window.mocha.run();

		runner.on("pass", function(test){
			testPasses.push({
				test: test
			});
		})
		.on("fail", function(test, err){
			testFailures.push({
				name: test.title,
				result: false,
				message: err.message,
				// stack: err.stack,
				titles: t.flattenTestTitles(test)
			});
		})
		.on("end", function() {
			complete = true;

			// for saucelabs-mocha
			window.mochaResults = runner.stats;
			window.mochaResults.reports = testFailures;

			// convenient way for selenium to wait
			var competeDiv = document.createElement("div");
			competeDiv.id = "BOOMR_test_complete";
			document.body.appendChild(competeDiv);
		});
	};

	t.init = function(config) {
		if (initialized) {
			return;
		}

		if (!window.BOOMR || !window.BOOMR.version) {
			window.BOOMR_test_config = config;
			return;
		}

		config = _.merge({}, t.CONFIG_DEFAULTS, config);

		if (config.testAfterOnBeacon) {
			// default to waiting until one beacon was sent, otherwise use
			// the number passed in
			if (typeof config.testAfterOnBeacon !== "number") {
				config.testAfterOnBeacon = 1;
			}

			BOOMR.subscribe("beacon", function() {
				if (++beaconsSeen === config.testAfterOnBeacon) {
					// wait a few more ms so the beacon fires
					// TODO: Trim this timing down if we can make it more reliable
					setTimeout(t.runTests, 1000);
				}
			});
		}

		t.doNotTestErrorsParam = config.doNotTestErrorsParam;

		if (window.BOOMR_LOGN_always !== true) {
			// initialize boomerang if LOGN is disabled
			BOOMR.addVar("h.cr", "test");
			BOOMR.init(config);
		}

		if (config.onBoomerangLoaded) {
			config.onBoomerangLoaded();
		}

		if (config.afterFirstBeacon) {
			var xhrSent = false;
			BOOMR.subscribe(
				"beacon",
				function() {
					if (xhrSent) {
						return;
					}
					xhrSent = true;

					config.afterFirstBeacon();
				});
		}

		// fake session details so beacons send
		BOOMR.addVar({
			"h.key": "aaaaa-bbbbb-ccccc-ddddd-eeeee",
			"h.d": "localhost",
			"h.t": new Date().getTime(),
			"h.cr": "abc"
		});

		t.configureTestEnvironment();

		if (!config.testAfterOnBeacon) {
			BOOMR.setImmediate(t.runTests);
		}

		initialized = true;
	};

	t.configureTestEnvironment = function() {
		// setup Mocha
		window.mocha.globals(["BOOMR", "PageGroupVariable", "mochaResults", "BOOMR_configt", "_bmrEvents"]);
		window.mocha.checkLeaks();

		// set globals
		assert = window.assert = window.chai.assert;
	};

	t.findResourceTimingBeacon = function() {
		if (!t.isResourceTimingSupported()) {
			return null;
		}

		// if included statically, it'll be on the main window
		var entries = BOOMR.window.performance.getEntriesByType("resource");
		for (var i = 0; i < entries.length; i++) {
			var e = entries[i];
			if (e.name && e.name.indexOf(t.BEACON_URL) !== -1) {
				return e;
			}
		}

		// if included via snippet, it'll be in the IFRAME
		var entries = BOOMR.boomerang_frame.performance.getEntriesByType("resource");
		for (var i = 0; i < entries.length; i++) {
			var e = entries[i];
			if (e.name && e.name.indexOf(t.BEACON_URL) !== -1) {
				return e;
			}
		}

		return null;
	};

	t.isResourceTimingSupported = function() {
		return (window.performance &&
		    typeof window.performance.getEntriesByType === "function" &&
		    typeof window.PerformanceResourceTiming !== "undefined");
	};

	t.isServerTimingSupported = function() {
		return this.isResourceTimingSupported() && typeof PerformanceServerTiming !== "undefined";
	};

	t.isQuerySelectorSupported = function() {
		return typeof window.document.querySelector === "function";
	};

	t.isNavigationTimingSupported = function() {
		return typeof BOOMR.plugins.RT.navigationStart() !== "undefined";
	};

	t.isNavigationTiming2Supported = function() {
		// check for NavTiming1 first
		if (!t.isNavigationTimingSupported()) {
			return false;
		}

		return window.performance &&
		    typeof window.performance.getEntriesByType === "function" &&
		    window.performance.getEntriesByType("navigation").length > 0;
	};

	t.isNavigationTiming2WithNextHopProtocolSupported = function() {
		// check for NavTiming1 first
		if (!t.isNavigationTimingSupported()) {
			return false;
		}

		return window.performance &&
		    typeof window.performance.getEntriesByType === "function" &&
		    window.performance.getEntriesByType("navigation").length > 0 &&
		    window.performance.getEntriesByType("navigation")[0].nextHopProtocol;
	};

	t.isChromeLoadTimesSupported = function() {
		var pt;
		if (window.chrome && window.chrome.loadTimes) {
			pt = window.chrome.loadTimes();
		}

		if (!pt) {
			// Not supported
			return false;
		}

		return true;
	};

	t.isPaintTimingSupported = function() {
		return window.performance &&
		    typeof window.PerformancePaintTiming !== "undefined" &&
		    typeof window.performance.getEntriesByType === "function";
	};

	t.isLongTasksSupported = function() {
		return window.PerformanceObserver && window.PerformanceLongTaskTiming;
	};

	t.isUserTimingSupported = function() {
		// don't check for PerformanceMark or PerformanceMeasure, they aren't polyfilled in usertiming.js
		return (window.performance &&
		    typeof window.performance.getEntriesByType === "function" &&
		    typeof window.performance.mark === "function" &&
		    typeof window.performance.measure === "function");
	};

	t.isNetworkAPISupported = function() {
		return (navigator && typeof navigator === "object" &&
			navigator.connection ||
			navigator.mozConnection ||
			navigator.webkitConnection ||
			navigator.msConnection);
	};

	t.isErrorObjInOnErrorSupported = function() {
		var ua = navigator.userAgent.toLowerCase();
		return (ua.indexOf("phantomjs") === -1);  // this should be extended to include older IE and Safari
	};

	t.isLocalStorageSupported = function() {
		var result = false, name = "_boomr_ilss";
		try {
			window.localStorage.setItem(name, name);
			result = (window.localStorage.getItem(name) === name);
			window.localStorage.removeItem(name);
		}
		catch (ignore) {
			result = false;
		}
		return result;
	};

	t.isJSONSupported = function() {
		return (typeof window.JSON === "object" &&
		    typeof window.JSON.stringify === "function" &&
		    typeof window.JSON.parse === "function");
	};

	t.validateBeaconWasImg = function(done) {
		if (!t.isResourceTimingSupported()) {
			// need RT to validate
			return done();
		}

		// the presence of h.t on the URL means it was a GET beacon, so not an IMG
		var res = this.findResourceTimingBeacon();
		assert.isTrue(res.name.indexOf("h.t") !== -1);

		done();
	};

	t.isMutationObserverSupported = function() {
		var w = window;
		// Use the same logic as BOOM.utils.isMutationObserverSupported.
		// Boomerang will not use MO in IE 11 due to browser bugs
		var ie11 = (w && w.navigator && w.navigator.userAgent && w.navigator.userAgent.match(/Trident.*rv[ :]*11\./));
		return (!ie11 && w && w.MutationObserver && typeof w.MutationObserver === "function");
	};

	t.validateBeaconWasXhr = function(done) {
		if (!t.isResourceTimingSupported()) {
			// need RT to validate
			return done();
		}

		// the presence of h.t on the URL means it was a GET beacon, so not an XHR
		var res = this.findResourceTimingBeacon();
		assert.isTrue(res.name.indexOf("h.t") === -1);

		done();
	};

	t.validateBeaconWasSent = function(done) {
		var tf = BOOMR.plugins.TestFramework;

		assert.isTrue(tf.fired_onbeacon, "ensure we fired a beacon ('beacon')");

		assert.isObject(tf.lastBeacon(), "ensure the data was sent to 'beacon'");

		assert.equal(tf.lastBeacon().v, BOOMR.version, "ensure the beacon has the boomerang version");

		done();
	};

	t.canSetCookies = function() {
		var testCookieName = "test_cookie";

		// set a cookie
		document.cookie = [testCookieName + "=true", "path=/", "domain=" + location.hostname].join("; ");

		// determine if it was set OK
		return (" " + document.cookie + ";").indexOf(" " + testCookieName + "=") !== -1;
	};

	t.clearCookies = function(domain) {
		var date = new Date();
		date.setTime(date.getTime() - (24 * 60 * 60 * 1000));
		var cookies = document.cookie.split(";");
		for (var i = 0; i < cookies.length; i++) {
			var name = cookies[i].split("=")[0].trim();
			document.cookie = [name + "=", "expires=" + date.toGMTString(), "path=/", "domain=" + (domain || location.hostname)].join("; ");
		}
	};

	t.clearLocalStorage = function() {
		// Clear localstorage
		if (typeof window.localStorage === "object" && typeof window.localStorage.clear === "function") {
			window.localStorage.clear();
		}
	};

	t.parseTimers = function(timers) {
		var timerValues = {};

		if (timers) {
			var timersSplit = timers.split(",");
			for (var i = 0; i < timersSplit.length; i++) {
				var timerSplit = timersSplit[i].split("|");
				timerValues[timerSplit[0]] = parseInt(timerSplit[1], 10);
			}
		}

		return timerValues;
	};

	/**
	* Finds the first load of the specified resource.
	* @param {string} url Partial URL match
	* @return {PerformanceResourceTiming} Last resource to load for that URL
	*/
	t.findFirstResource = function(url) {
		if ("performance" in window &&
			window.performance &&
			window.performance.getEntriesByType) {
			var entries = window.performance.getEntriesByType("resource");

			for (var i = 0; i < entries.length; i++) {
				if (entries[i].name.indexOf(url) !== -1) {
					return entries[i];
				}
			}
		}

		return null;
	};

	/**
	 * Finds the first beacon with the specified parameter
	 *
	 * @param {string} prop Property name
	 * @param {string} val Property value
	 *
	 * @returns {object} Matching beacon
	 */
	t.findMatchingBeacon = function(prop, val) {
		var tf = BOOMR.plugins.TestFramework;

		for (var i = 0; i < tf.beacons.length; i++) {
			if (tf.beacons[i][prop] === val) {
				return tf.beacons[i];
			}
		}
	};

	/**
	 * Finds the first XHR beacon
	 *
	 * @returns {object} XHR beacon
	 */
	t.findXhrBeacon = function() {
		return t.findMatchingBeacon("http.initiator", "xhr");
	};

	/**
	 * Finds the first navigation beacon
	 *
	 * @returns {object} navigation beacon
	 */
	t.findNavBeacon = function() {
		return t.isNavigationTimingSupported() ?
		    t.findMatchingBeacon("rt.start", "navigation") :
		    t.findMatchingBeacon("rt.start", "none");
	};

	/**
	* Finds the last load of the specified resource.
	* @param {string} url Partial URL match
	* @return {PerformanceResourceTiming} Last resource to load for that URL
	*/
	t.findLastResource = function(url) {
		if ("performance" in window &&
			window.performance &&
			window.performance.getEntriesByType) {
			var entries = window.performance.getEntriesByType("resource");

			var res = null;
			for (var i = 0; i < entries.length; i++) {
				if (entries[i].name.indexOf(url) !== -1) {
					if (res === null || entries[i].responseEnd > res.responseEnd) {
						res = entries[i];
					}
				}
			}

			return res;
		}
		else {
			return null;
		}
	};

	/**
	* Finds the nth load of the specified resource.
	* @param {string} url Partial URL match
	* @param {number} n Nth resource
	* @return {PerformanceResourceTiming} Last resource to load for that URL
	*/
	t.findNthResource = function(url, n) {
		if ("performance" in window &&
			window.performance &&
			window.performance.getEntriesByType) {
			var entries = window.performance.getEntriesByType("resource");
			var res = null;
			var matches = 0;

			for (var i = 0; i < entries.length; i++) {
				if (entries[i].name.indexOf(url) !== -1) {
					if (res === null || entries[i].responseEnd > res.responseEnd) {
						if (matches === n) {
							res = entries[i];
							break;
						}

						matches++;
					}
				}
			}

			return res;
		}
		else {
			return null;
		}
	};

	/**
	 * Validates the beacon was sent with a load time equal to when the specified resource
	 * loaded.
	 *
	 * @param {number} beaconIndex Which beacon
	 * @param {string} urlMatch URL to match
	 * @param {number} closeTo Range that the load time can be off by
	 * @param {number} fallbackMin If RT is not supported, the minimum time
	 * @param {number} fallbackMax If RT is not supported, the maximum time
	 * @param {boolean|number} useLastMatch Use the last match of the resource instead of the first, or, if a number, that resource
	 * @param {number} n Check the nth resource
	 */
	t.validateBeaconWasSentAfter = function(beaconIndex, urlMatch, closeTo, fallbackMin, fallbackMax, useLastMatch) {
		var tf = BOOMR.plugins.TestFramework;

		var res;
		if (typeof useLastMatch === "number") {
			res = t.findNthResource(urlMatch, useLastMatch);
		}
		else {
			res = useLastMatch ? t.findLastResource(urlMatch) : t.findFirstResource(urlMatch);
		}

		if (res !== null) {
			assert.closeTo(tf.beacons[beaconIndex].t_done, res.responseEnd, closeTo);
		}
		else {
			// we don't have ResourceTiming, use the fallback times
			assert.operator(tf.beacons[beaconIndex].t_done, ">=", fallbackMin);
			assert.operator(tf.beacons[beaconIndex].t_done, "<=", fallbackMax);
		}
	};

	/**
	 * Ensures the number of beacons specified were sent.
	 *
	 * Also waits a second after the beacon count was hit to ensure no additional
	 * beacons were sent.
	 *
	 * @param {function} done Callback
	 * @param {number} beaconCount Expected beacon count
	 */
	t.ensureBeaconCount = function(done, beaconCount) {
		function compareBeaconCount() {
			return BOOMR.plugins.TestFramework.beaconCount() === beaconCount;
		}
		function testBeaconCount() {
			if (compareBeaconCount()) {
				setTimeout(
					function() {
						done(compareBeaconCount() ? undefined : new Error("beaconCount: " + BOOMR.plugins.TestFramework.beaconCount() + " !== " + beaconCount));
					}, 1000);
			}
			else {
				if (BOOMR.plugins.TestFramework.beaconCount() > beaconCount) {
					done(new Error("Too many beacons!  Expected " + beaconCount + " but got " + BOOMR.plugins.TestFramework.beaconCount()));
				}
				else {
					setTimeout(testBeaconCount, 100);
				}
			}
		}

		testBeaconCount();
	};

	/**
	 * Runs the specified callback if AutoXHR is enabled
	 *
	 * @param {function} done Test done callback
	 * @param {function} testXhr Test to run if AutoXHR is enabled
	 * @param {function} testDegenerate Test if AutoXHR is not enabled
	 */
	t.ifAutoXHR = function(done, testXhr, testDegenerate) {
		if (BOOMR.plugins.AutoXHR) {
			return (testXhr || done || function(){})();
		}
		(testDegenerate || done || function(){})();
	};


	/**
	 * Determines how many elements on the page match the attribute
	 *
	 * @param {string} tagName Tag name
	 * @param {string} attr Attribute name
	 * @param {RegExp} regex Regular expression matching the attribute
	 * @returns {number} Number of elements matching
	 */
	t.elementsWithAttribute = function(tagName, attr, regex) {
		var nodes = document.getElementsByTagName("script");

		var matching = 0;

		for (var i = 0; i < nodes.length; i++) {
			var node = nodes[i];
			if (node[attr] && node[attr].match(regex)) {
				matching++;
			}
		}

		return matching;
	};

	/**
	 * Runs a function repeatedly the specified number of times with the
	 * specified delay.
	 *
	 * @param {function} run Function to run
	 * @param {number} times How many times to run it
	 * @param {number} delay How often to delay between runs
	 * @param {function} done What to run when done
	 */
	t.runRepeatedly = function(run, times, delay, done) {
		var runTimes = 0;

		function repeat() {
			if (++runTimes === times) {
				return done();
			}

			run();

			setTimeout(repeat, delay);
		}

		repeat();
	};

	/**
	 * Shows a countdown clock on the page
	 *
	 * @param {Object} test Mocha test case
	 * @param {number} maxTime Maximum timeout
	 * @param {number} expectedTime How many expected seconds
	 *
	 * @returns {string} Timer ID you can use to clearTimeout later
	 */
	t.timeout = function(test, maxTime, expectedTime) {
		test.timeout(maxTime);

		var stats = document.getElementById("mocha-stats");

		var el = document.createElement("li");

		stats.appendChild(el);

		var startTime = +(new Date());
		var endTimeExpected = startTime + expectedTime;
		var endTimeMax = startTime + maxTime;

		var timerID = setInterval(function(){
			var now = +(new Date());
			if (now > endTimeMax) {
				clearInterval(timerID);

				el.parentNode.removeChild(el);

				return;
			}
			else if (now > endTimeExpected) {
				el.style["font-color"] = "red";
			}

			var timeLeft = endTimeMax - now;

			el.innerHTML = "timeout: <em>" + (Math.floor(timeLeft / 100) / 10).toFixed(1) + "</em>s";
		}, 100);

		el.id = "mocha-timer" + timerID;

		return timerID;
	};

	/**
	 * Clears a previously set timer ID
	 *
	 * @param {string} timerID TimerID
	 */
	t.clearTimeout = function(timerID) {
		clearInterval(timerID);

		var el = document.getElementById("mocha-timer" + timerID);
		if (el) {
			el.parentNode.removeChild(el);
		}
	};

	/**
	 * Filters list of strings for number of strings containing a string
	 *
	 * @param {string} string - String to search for
	 * @param {string[]} list - array of strings to test for string
	 *
	 * @returns {string[]} list of strings matching
	 */
	t.checkStringInArray = function(string, list) {
		return list.filter(function(content) {
			return content.indexOf(string) > -1;
		});
	};

	/**
	 * Creates a copy of window.performance that can be modified by the caller.
	 */
	t.getPerformanceCopy = function() {
		if (!("performance" in window)) {
			return;
		}

		var copy = {};

		// copy over all values
		var objs = ["timing", "navigation"];
		for (var i = 0; i < objs.length; i++) {
			var objName = objs[i];
			var subObj = window.performance[objName];

			if (subObj) {
				if (typeof subObj === "function") {
					copy[objName] = window.performance[objName];
					continue;
				}
				copy[objName] = {};
				for (var subObjAttr in subObj) {
					copy[objName][subObjAttr] = subObj[subObjAttr];
				}
			}
		}

		return copy;
	};

	/**
	 * Gets the latest of First Paint or First Contentful Paint
	 *
	 * @returns {number} FP or FCP
	 */
	t.getFirstOrContentfulPaint = function() {
		var fp = 0;
		var p = window.performance;

		// use First Paint (if available)
		if (BOOMR.plugins.PaintTiming &&
			BOOMR.plugins.PaintTiming.is_supported() &&
			p &&
			p.timeOrigin) {
			fp = BOOMR.plugins.PaintTiming.getTimingFor("first-contentful-paint");
			if (!fp) {
				// or get First Paint directly from PaintTiming
				fp = BOOMR.plugins.PaintTiming.getTimingFor("first-paint");
			}

			if (fp) {
				// convert to epoch
				fp = Math.round(fp + p.timeOrigin);
			}
		}
		else if (p && p.timing && p.timing.msFirstPaint) {
			fp = p.timing.msFirstPaint;
		}
		else if (window.chrome &&
			typeof window.chrome.loadTimes === "function") {
			var loadTimes = window.chrome.loadTimes();
			if (loadTimes && loadTimes.firstPaintTime) {
				fp = loadTimes.firstPaintTime * 1000;
			}
		}

		return fp;
	};

	/**
	 * Do busy work for the specified number of ms
	 */
	t.busy = function(ms) {
		var startTime = (new Date()).getTime();
		var now = startTime;
		var endTime = startTime + ms;
		var math = 1;

		while (now < endTime) {
			now = (new Date()).getTime();
			math *= 2;
			math *= 0.5;
		}
	};

	/**
	 * Determines the user agent is Internet Explorer or not
	 *
	 * @returns {boolean} True if the user agent is Internet Explorer
	 */
	t.isIE = function() {
		return window.navigator &&
			(window.navigator.userAgent.indexOf("MSIE") !== -1 ||
			window.navigator.appVersion.indexOf("Trident/") > 0);
	};

	window.BOOMR_test = t;

	// force LOGN plugin not to run. Individual tests will override this if needed.
	// This only works if the test framework is loaded before boomerang
	window.BOOMR_LOGN_always = false;

	/*eslint-disable no-extend-native*/
	// Polyfill via https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function/bind
	if (!Function.prototype.bind) {
		Function.prototype.bind = function(oThis) {
			if (typeof this !== "function") {
				// closest thing possible to the ECMAScript 5
				// internal IsCallable function
				throw new TypeError("Function.prototype.bind - what is trying to be bound is not callable");
			}

			var aArgs   = Array.prototype.slice.call(arguments, 1),
			fToBind = this,
			fNOP    = function() {},
			fBound  = function() {
				return fToBind.apply(this instanceof fNOP ? this : oThis,
					aArgs.concat(Array.prototype.slice.call(arguments)));
			};

			if (this.prototype) {
				// Function.prototype doesn't have a prototype property
				fNOP.prototype = this.prototype;
			}
			fBound.prototype = new fNOP();

			return fBound;
		};
	}
	/*eslint-enable no-extend-native*/

}(window));
