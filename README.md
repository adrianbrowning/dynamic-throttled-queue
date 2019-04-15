# dynamic-throttled-queue

This project was forked from [shaunpersad/throttled-queue](https://github.com/shaunpersad/throttled-queue)

Dynamically throttles arbitrary code to execute between a minuimum and maximum number of times per interval. Best for making throttled API requests.

For example, making network calls to popular APIs such as Twitter is subject to rate limits.  By wrapping all of your API calls in a throttle, it will automatically adjust your requests to be within the acceptable rate limits.

Unlike the `throttle` functions of popular libraries like lodash and underscore, `dynamic-throttled-queue` will not prevent any executions. Instead, every execution is placed into a queue, which will be drained at the desired rate limit.

## Release Notes
v1.0.0 - Initial Release

v1.1.0 - Adding Retry ability, if returning false, function will be added back to the master queue to be retired.

## Installation
Can be used in a Node.js environment, or directly in the browser.
### Node.js
`npm install dynamic-throttled-queue`
### Browser
`<script src="dynamic-throttled-queue.min.js"></script>`

##Options

| Param  | Type                | Description  |
| ------ | ------------------- | ------------ |
| min_rpi | <code>{number}</code> | Minimum requests per interval |
| max_rpi | <code>[number=min_rpi]</code> | Maximum requests per interval |
| interval | <code>{number}</code> | Number of milliseconds between each batch of requests |
| evenly_spaced | <code>[boolean=true]</code> | If true requests will be distributed throughout the interval time |
| errors\_per\_second | <code>[number=5]</code> | Number of errors per second before deciding to either increase or decrease the current rpi |
| back_off | <code>[boolean=true]</code> | If true and we hit the errors_per_interval watermark, we will back off for 1 interval |
| retry | <code>[number=0]</code> | If greater than 0, any failed callbacks, will be put back onto the queue to retry upto X times |


## Usage
1) If in node.js, `require` the factory function:

```js
var throttledQueue = require('dynamic-throttled-queue');
```
Else, include it in a script tag in your browser and `throttledQueue` will be globally available.

2) Create an instance of a throttled queue by specifying the maximum number of requests as the first parameter,
and the interval in milliseconds as the second:

```js
const throttle = throttledQueue({min_rpi:5, interval:1000}); // at most 5 requests per second.
```
3) Use the `throttle` instance as a function to enqueue actions:

```js
throttle(function() {
    // perform some type of activity in here.
});
```

## Quick Examples
### Basic
Rapidly assigning network calls to be run, but they will be limited to 1 request per second.

```js
var throttledQueue = require('dynamic-throttled-queue');
var throttle = throttledQueue({min_rpi:1, interval:1000}); // at most make 1 request every second.

for (let i = 0; i < 100; i++) {

    throttle(function() {
        // make a network request.
        fetch('https://api.github.com/search/users?q=adrianbrowning').then(console.log);
    });
}
```
### Reusable
Wherever the `throttle` instance is used, your action will be placed into the same queue, 
and be subject to the same rate limits.

```js
const throttledQueue = require('throttled-queue');
const throttle = throttledQueue({min_rpi:1, interval:60 * 1000}); // at most make 1 request every minute.

for (let x = 0; x < 50; x++) {

    throttle(function() {
        // make a network request.
        fetch('https://api.github.com/search/users?q=adrianbrowning').then(console.log);
    });
}
for (let y = 0; y < 50; y++) {

    throttle(function() {
        // make another type of network request.
        fetch('https://api.github.com/search/repositories?q=throttled-queue+user:adrianbrowning').then(console.log);
    });
}
```
### Bursts
By specifying a number higher than 1 for the min_rpi, and setting `evenly_spaced: false` you can dequeue multiple actions within the given interval:

```js
var throttledQueue = require('throttled-queue');
var throttle = throttledQueue({min_rpi:10, interval:1000, evenly_spaced: true}); // at most make 10 requests every second.

for (let x = 0; x < 100; x++) {

    throttle(function() {
        // This will fire at most 10 a second, as rapidly as possible.
        fetch('https://api.github.com/search/users?q=adrianbrowning').then(console.log);
    });
}
```
### Evenly spaced
By default your actions are evenly distributed over the interval `evenly_spaced: true`:

```js
const throttledQueue = require('throttled-queue');
const throttle = throttledQueue({min_rpi: 10, interval: 1000, evenly_spaced:true}); // at most make 10 requests every second, but evenly spaced.

for (let x = 0; x < 100; x++) {

    throttle(function() {
        // This will fire at most 10 requests a second, spacing them out instead of in a burst.
        fetch('https://api.github.com/search/users?q=adrianbrowning').then(console.log);
    });
}
```

### Min & Max Requests Per Interval
By suppling a `min_rpi` & `max_rpi` value to the options object, you will be able to have a dynamically adjusting queue. This works by the function passed to `throttle` returning `false` if there was an issue. The starting requests per interval is as close to halfway bewteen the `min_rpi` and `max_rpi`, rounded to the nearest whole number.

The second part of this is the `errors_per_second` option. This is set by default to 5 errors per second. Every X seconds, a check is made to see how many errors we have seen (through the use of `return false`) and if we see X or more, then the current requests per interval will decrease until we hit the `min_rpi` value. If between 0 - X errors are seen then we keep with the current requests per interval as is. Finally if there are 0 errors in the last check period then we will increase the current requests per interval until we reach `max_rpi`.

```js
const throttledQueue = require('throttled-queue');
const throttle = throttledQueue({min_rpi: 1, max_rpi:5, interval: 1000}); // at most make 5 requests every second.

for (let x = 0; x < 100; x++) {

    throttle(function() {
			return !(Date.now() % 2);
    });
}
```

### Backoff
By suppling `backoff:true` in the options, every time we hit the `errors_per_second` mark, we will backoff from the next batch of calls for 1 inteveral 

```js
const throttledQueue = require('throttled-queue');
const throttle = throttledQueue({min_rpi: 10, interval: 1000, backoff:true, errors_per_second:2}); 
// at most make 10 requests every second, if more than 2 errors per second, then back off for 1 full interval of 1 second.

for (let x = 0; x < 100; x++) {

    throttle(function() {
			return !(Date.now() % 2);
    });
}
```


## Tests
Note: The tests take a few minutes to run. Watch the console to see how closely the actual rate limit gets to the maximum.
### Node.js
Run `npm test`.
### Browser
Open `test/index.html` in your browser.



