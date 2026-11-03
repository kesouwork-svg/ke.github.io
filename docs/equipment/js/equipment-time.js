/* Equipment time contract: Beijing business time (Asia/Shanghai, UTC+08:00).
 * No local-time parsing, browser timezone, input coercion or historical DST.
 * Legacy dates remain dates; only their deadline/input representation is derived.
 */
(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module && module.exports) {
        module.exports = factory();
    } else if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else {
        root.EquipTime = factory();
    }
}(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
    'use strict';
    var DAY = 86400000, OFFSET = 8 * 3600000;

    function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
    function pad(value, size) {
        var result = String(value);
        while (result.length < size) result = '0' + result;
        return result;
    }

    /** Strict civil date/minute only. ms is an instant, not a local Date. */
    function parse(value) {
        if (typeof value !== 'string') return null;
        var match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(value);
        if (!match || match[0] !== value) return null;
        var year = Number(match[1]), month = Number(match[2]), date = Number(match[3]);
        var datetime = match[4] !== undefined;
        var hour = datetime ? Number(match[4]) : 0, minute = datetime ? Number(match[5]) : 0;
        if (year < 1 || month < 1 || month > 12 || date < 1 || date > 31 || hour > 23 || minute > 59) return null;
        // Date.UTC remaps 0000..0099 to 1900..1999. setUTCFullYear does not.
        var utc = new Date(0);
        utc.setUTCHours(0, 0, 0, 0);
        utc.setUTCFullYear(year, month - 1, date);
        if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== date) return null;
        var day = value.slice(0, 10);
        return {
            kind: datetime ? 'datetime' : 'date', day: day, value: value,
            ms: utc.getTime() - OFFSET + (datetime ? hour * 3600000 + minute * 60000 : DAY - 1),
            input: datetime ? value : day + 'T23:59'
        };
    }

    function normalize(value) {
        if (value === '') return '';
        var parsed = parse(value);
        return parsed ? parsed.value : null;
    }
    function day(ms) {
        if (!finite(ms)) return '';
        var utc = new Date(ms + OFFSET), year = utc.getUTCFullYear();
        if (!Number.isFinite(utc.getTime()) || year < 1 || year > 9999) return '';
        return pad(year, 4) + '-' + pad(utc.getUTCMonth() + 1, 2) + '-' + pad(utc.getUTCDate(), 2);
    }
    function stamp(ms) {
        var date = day(ms);
        if (!date) return '';
        var utc = new Date(ms + OFFSET);
        return date + 'T' + pad(utc.getUTCHours(), 2) + ':' + pad(utc.getUTCMinutes(), 2);
    }
    function defaultDue(ms) { return finite(ms) ? stamp(ms + DAY) : ''; }
    function input(value) { var parsed = parse(value); return parsed ? parsed.input : ''; }
    // The caller must HTML-escape this display text, including invalid raw strings.
    function format(value) {
        var parsed = parse(value);
        return parsed ? parsed.value.replace('T', ' ') : (typeof value === 'string' ? value : '');
    }
    function overdueMs(value, nowMs) {
        var parsed = parse(value);
        return parsed && finite(nowMs) && nowMs > parsed.ms ? nowMs - parsed.ms : 0;
    }
    /** doneAt is a registered date: never invent a completion hour/minute. */
    function delayDays(expected, doneDate) {
        var due = parse(expected), done = parse(doneDate);
        if (!due || !done || done.kind !== 'date') return 0;
        return Math.max(0, (done.ms - parse(due.day).ms) / DAY);
    }
    function isDelayed(expected, doneDate) { return delayDays(expected, doneDate) > 0; }

    return {
        parse: parse, normalize: normalize, stamp: stamp, day: day, defaultDue: defaultDue,
        input: input, format: format, overdueMs: overdueMs, delayDays: delayDays, isDelayed: isDelayed
    };
}));
