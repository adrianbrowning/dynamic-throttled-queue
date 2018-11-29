var gulp = require('gulp');

var uglify = require('gulp-uglify');
var rename = require('gulp-rename');
babel = require('gulp-babel');

gulp.task('default', function() {
    return gulp.src('./dynamic-throttled-queue.js')
        .pipe(rename('dynamic-throttled-queue.min.js'))
        .pipe(babel({presets: ['@babel/env']}))
        .pipe(uglify())
        .pipe(gulp.dest('./'));
});
