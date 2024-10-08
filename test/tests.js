function calculateRPMS(num_requests, time_started) {

    return num_requests / (Date.now() - time_started);

}

function cb(rate) {
    console.log('Rate:', rate);
}

describe('dynamic-throttled-queue', function() {

    it('should queue all callbacks', function(done) {

        var requests_per_interval = 1;
        var interval = 200;
        var throttle = throttledQueue({min_rpi:requests_per_interval, interval:interval, cb});
        var num_requests = 0;
        var request_limit = 100;
        for (var x = 0; x < request_limit; x++) {
            throttle(function() {
                console.log('Throttling...');
                num_requests++;
            });
        }
        throttle(function() {
            if (num_requests !== request_limit) {
                throw new Error('Not all callbacks queued.');
            }
            done();
        });
    });

    it('should queue the callback within the interval', function(done) {

        var requests_per_interval = 1;
        var interval = 200;
        var throttle = throttledQueue({min_rpi:requests_per_interval, interval:interval, cb});
        var last_executed = Date.now();

        var num_requests = 0;
        var request_limit = 100;

        for (var x = 0; x < request_limit; x++) {
            throttle(function() {
                console.log('Throttling...');
                var now = Date.now();
                var time_elapsed = now - last_executed;
                if (time_elapsed < interval) {
                    throw new Error('Did not honor interval.');
                }
                last_executed = now;
                num_requests++;
            });
        }
        throttle(function() {
            if (num_requests !== request_limit) {
                throw new Error('Not all callbacks queued.');
            }
            done();
        });
    });

    it('should queue the callback and honor the interval', function(done) {

        var requests_per_interval = 1;
        var interval = 500;
        var throttle = throttledQueue({min_rpi:requests_per_interval, interval:interval, cb});
        var time_started = Date.now();
        var max_rpms = requests_per_interval / interval;

        var num_requests = 0;
        var request_limit = 100;

        for (var x = 0; x < request_limit; x++) {
            throttle(function() {
                var rpms = calculateRPMS(++num_requests, time_started);
                console.log(rpms, max_rpms);
                if (rpms > max_rpms) {
                    throw new Error('Did not honor interval.');
                }
            });
        }
        throttle(function() {
            if (num_requests !== request_limit) {
                throw new Error('Not all callbacks queued.');
            }
            done();
        });
    });

    it('should queue the callback and honor the interval with multiple requests per interval', function(done) {

        var requests_per_interval = 3;
        var interval = 1000;
        var throttle = throttledQueue({min_rpi:requests_per_interval, interval:interval, cb});
        var time_started = Date.now();
        var max_rpms = requests_per_interval / interval;

        var num_requests = 0;
        var request_limit = 100;

        for (var x = 0; x < request_limit; x++) {
            throttle(function() {
                var rpms = calculateRPMS(++num_requests, time_started);
                console.log(rpms, max_rpms);
                if (rpms > max_rpms) {
                    throw new Error('Did not honor interval.');
                }
            });
        }
        throttle(function() {
            if (num_requests !== request_limit) {
                throw new Error('Not all callbacks queued.');
            }
            done();
        });
    });

    it('should queue the callback and honor the interval with multiple evenly spaced requests per interval', function(done) {

        var requests_per_interval = 3;
        var interval = 1000;
        var throttle = throttledQueue({min_rpi:requests_per_interval, interval:interval, cb}, true);
        var time_started = Date.now();
        var max_rpms = requests_per_interval / interval;

        var num_requests = 0;
        var request_limit = 100;

        for (var x = 0; x < request_limit; x++) {
            throttle(function() {
                var rpms = calculateRPMS(++num_requests, time_started);
                console.log(rpms, max_rpms);
                if (rpms > max_rpms) {
                    throw new Error('Did not honor interval.');
                }
            });
        }
        throttle(function() {
            if (num_requests !== request_limit) {
                throw new Error('Not all callbacks queued.');
            }
            done();
        });
    });

    it('should add items back to the queue if return false', function(done){
        const requests_per_interval = 5;
        const interval = 200;
        const retry = 2;
        const throttle = throttledQueue({min_rpi:requests_per_interval, interval:interval,evenly_spaced:false, retry, cb}, true);

        let num_requests = 0;
        const request_limit = 5;
        const max_requests = request_limit * (retry + 1);

        const callBacks = {};

        for (let x = 0; x < request_limit; x++) {
            throttle(function() {
                callBacks[x] = callBacks[x] || 0;
                callBacks[x]++;
                num_requests++;


                if (num_requests === max_requests ) {
                    done();
                }

                return false;
            });
        }
    });

    it('should add half items back to the queue if return false mod 2', function(done){
        const requests_per_interval = 5;
        const interval = 200;
        const retry = 2;
        const throttle = throttledQueue({min_rpi:requests_per_interval, interval:interval,evenly_spaced:false, retry, cb}, true);

        let num_requests = 0;
        const request_limit = 5;
        const max_requests = (request_limit * retry) + 1;

        const callBacks = {};

        for (let x = 0; x < request_limit; x++) {
            throttle(function() {
                callBacks[x] = callBacks[x] || 0;
                callBacks[x]++;
                num_requests++;


                if (num_requests === max_requests ) {
                    done();
                }

                return !!(x % 2);
            });
        }
    });
});
