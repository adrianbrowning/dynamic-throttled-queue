"use strict";

(function () {
// global on the server, window in the browser
  var previous_throttledQueue, debug = false;

  function debugFn(...msgs) {
    if (debug) console.log(msgs);
  }

  function typeOf(e) {
    return ({}).toString.call(e).match(/\s([a-zA-Z]+)/)[ 1 ].toLowerCase();
  }

  // Establish the root object, `window` (`self`) in the browser, `global`
  // on the server, or `this` in some virtual machines. We use `self`
  // instead of `window` for `WebWorker` support.
  const root = typeof self === 'object' && self.self === self && self ||
    typeof global === 'object' && global.global === global && global ||
    this;

  if (root != null) {
    previous_throttledQueue = root.throttledQueue;
  }

  /**
   * Factory function.
   *
   * @param min_rpi {number} - Minimum requests per interval
   * @param max_rpi [number=min_rpi] - Maximum requests per interval
   * @param interval {number} - Number of milliseconds between each batch of requests
   * @param evenly_spaced [boolean=true] - If true requests will be distributed throughout the interval time
   * @param errors_per_second [number=5] - Number of errors per second before deciding to either increase or decrease the current rpi
   * @param back_off [boolean=true] - If true and we hit the errors_per_interval watermark, we will back off for 1 interval
   * @param retry [number=0] - If greater than 0, any failed callbacks, will be put back onto the queue to retry upto X times
   *
   * @returns {Function}
   */
  const throttledQueue = function (options = {}) {

    const {
            min_rpi,
            interval,
            max_rpi           = min_rpi,
            evenly_spaced     = true,
            errors_per_second = 5,
            back_off          = false,
            retry = 0
          } = options;

    debug = typeOf(options.debug) !== "undefined" ? options.debug === true : false;

    if (typeOf(min_rpi) !== "number") {
      throw new Error("min_rpi must be a number");
    }
    if (!Number.isInteger(min_rpi)) {
      throw new Error("min_rpi is not an integer");
    }
    if (min_rpi < 1) {
      throw new Error("min_rpi should be greater than 0");
    }
    if (typeOf(max_rpi) !== "number") {
      throw new Error("max_rpi must be a number");
    }
    if (!Number.isInteger(max_rpi)) {
      throw new Error("max_rpi is not an integer");
    }
    if (max_rpi < min_rpi) {
      throw new Error("max_rpi is less than min_rpi");
    }
    if (typeOf(interval) !== "number") {
      throw new Error("interval must be a number");
    }
    if (typeOf(errors_per_second) !== "number") {
      throw new Error("errors_per_second must be a number");
    }
    if (typeOf(evenly_spaced) !== "boolean") {
      throw new Error("evenly_spaced must be a boolean");
    }
    if (typeOf(back_off) !== "boolean") {
      throw new Error("back_off must be a boolean");
    }
    if (typeOf(retry) !== "number") {
      throw new Error("retry must be a number");
    }

    var dyn_interval              = interval,
        dyn_requests_per_interval = Math.ceil(max_rpi - ((max_rpi - min_rpi) / 2)),
        current_rpi               = dyn_requests_per_interval,
        error_count               = 0,
        bSkippedLast              = false,
        isRunning                 = false;

    /**
     * If all requests should be evenly spaced, adjust to suit.
     */
    if (evenly_spaced) {
      dyn_interval = dyn_interval / dyn_requests_per_interval;
      dyn_requests_per_interval = 1;
    }

    if (dyn_interval < 200) {
      console.warn('An interval of less than 200ms can create performance issues.');
    }

    const queue = [];
    let last_called = Date.now();

    /**
     * Gets called at a set interval to remove items from the queue.
     * This is a self-adjusting timer,
     * since the browser's setTimeout is highly inaccurate.
     */
    const dequeue = function () {

      const threshold = last_called + dyn_interval;
      const now = Date.now();

      /**
       * Adjust the timer if it was called too early.
       */
      if (now < threshold) {
        clearTimeout(timeout);
        timeout = setTimeout(dequeue, threshold - now);
        return;
      }
      const callbacks = queue.splice(0, dyn_requests_per_interval);
      for (let x = 0; x < callbacks.length; x++) {
        let cb =  callbacks[ x ];
        let result = typeOf(cb) === "function" ? cb() : cb.fn();
        if (result === false) {
          error_count++;
          if (retry > 0) {
            if (typeOf(cb) === "function") {
              queue.push({retry, fn : cb});
            } else if (typeOf(cb) === "object" && (--cb.retry) !== 0) {
              queue.push(cb);
            }
          }
        }
      }
      bSkippedLast = false;

      last_called = Date.now();
      if (queue.length === 0) {
        isRunning = !1;
        clearTimeout(timeout);
        clearTimeout(dyn_timeout);
        return;
      }
      timeout = setTimeout(dequeue, dyn_interval);
    };
    const alterDYN_rpi = function () {

      debugFn('Error Count:', error_count);
      if (error_count >= errors_per_second) {
        debugFn('Decreasing rate limit');
        current_rpi = Math.max(min_rpi, current_rpi - 1);
        //decrease dyn count by 1
        if (evenly_spaced) {
          dyn_interval = interval / current_rpi;
        } else {
          dyn_requests_per_interval = current_rpi;
        }

        if (back_off && !bSkippedLast) {
          const threshold = last_called + dyn_interval;
          const now = Date.now();

          /**
           * Adjust the timer if it was called too early.
           */
          if (now < threshold) {
            clearTimeout(timeout);
            bSkippedLast = true;
            timeout = setTimeout(dequeue, (threshold - now) + interval);
          }
        }

      } else if (!bSkippedLast && error_count === 0 && queue.length > 0) {
        debugFn('Increasing rate limit');
        current_rpi = Math.min(max_rpi, current_rpi + 1);
        //increase dyn count by 1
        if (evenly_spaced) {
          dyn_interval = interval / current_rpi;
        } else {
          dyn_requests_per_interval = current_rpi;
        }
      }
      error_count = 0;
      debugFn(`current_rpi: ${current_rpi}`);
      dyn_timeout = setTimeout(alterDYN_rpi, interval);
    };

    /**
     * Kick off the timer.
     */
    var timeout = setTimeout(dequeue, dyn_interval);

    var dyn_timeout = setTimeout(alterDYN_rpi, interval);

    isRunning = !0;

    /**
     * Return a function that can enqueue items.
     */
    return function (callback) {
      queue.push(callback);
      if (!isRunning) {
        isRunning = !0;
        timeout = setTimeout(dequeue, dyn_interval);
        dyn_timeout = setTimeout(alterDYN_rpi, interval);
      }
    };
  };

  throttledQueue.noConflict = function () {
    root.throttledQueue = previous_throttledQueue;
    return throttledQueue;
  };

  // Node.js
  if (typeof module === 'object' && module.exports) {
    module.exports = throttledQueue;
  }
  // AMD / RequireJS
  else if (typeof define === 'function' && define.amd) {
    define([], function () {
      return throttledQueue;
    });
  }
  // included directly via <script> tag
  else {
    root.throttledQueue = throttledQueue;
  }

}).call(this);