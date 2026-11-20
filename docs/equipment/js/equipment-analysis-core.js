/*
 * Equipment maintenance analysis V1: deterministic, read-only; depends on EquipTime.
 * Input must already be restricted to the current account's visible equipment.
 * This module does not fetch data or reconstruct historical backlog.
 */
(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module && module.exports) {
        module.exports = factory(require('./equipment-time.js'));
    } else if (typeof define === 'function' && define.amd) {
        define(['./equipment-time'], factory);
    } else {
        root.EquipAnalysis = factory(root.EquipTime);
    }
}(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (EquipTime) {
    'use strict';

    if (!EquipTime || typeof EquipTime.parse !== 'function') throw new Error('EquipTime is required before EquipAnalysis.');
    var DAY = 86400000;
    var hasOwn = Object.prototype.hasOwnProperty;
    var KNOWN_TYPES = ['fault', 'maintain', 'overhaul', 'modify', 'inspect'];

    // Read own data properties only; never invoke an input accessor or trust its prototype.
    function own(object, key) {
        if (!object || (typeof object !== 'object' && typeof object !== 'function')) return undefined;
        var descriptor = Object.getOwnPropertyDescriptor(object, key);
        return descriptor && hasOwn.call(descriptor, 'value') ? descriptor.value : undefined;
    }

    function isObject(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    function text(value) {
        return typeof value === 'string' ? value : '';
    }

    function nonblank(value) {
        return typeof value === 'string' && value.trim().length > 0;
    }

    function missing(value) {
        return value === undefined || value === null || (typeof value === 'string' && !value.trim());
    }

    /** Strict YYYY-MM-DD -> UTC midnight milliseconds; invalid input -> null. */
    function parseDate(dateString) {
        if (typeof dateString !== 'string' || dateString.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) return null;
        var year = Number(dateString.slice(0, 4));
        var month = Number(dateString.slice(5, 7));
        var day = Number(dateString.slice(8, 10));
        if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
        // setUTCFullYear avoids Date.UTC's special treatment of years 00..99.
        var date = new Date(0);
        date.setUTCHours(0, 0, 0, 0);
        date.setUTCFullYear(year, month - 1, day);
        return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
            ? date.getTime() : null;
    }

    function formatDate(time) {
        var date = new Date(time);
        var year = String(date.getUTCFullYear());
        while (year.length < 4) year = '0' + year;
        return year + '-' + ('0' + (date.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + date.getUTCDate()).slice(-2);
    }

    // asOfTime is an instant: finite epoch milliseconds or a strict ISO with zone.
    // Reuse EquipTime's civil validation; Date.parse would silently roll bad dates.
    function parseAsOfTime(value) {
        if (typeof value === 'number') return Number.isFinite(value) && EquipTime.day(value) ? value : null;
        if (typeof value !== 'string') return null;
        var match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
        if (!match || match[0] !== value) return null;
        var parsed = EquipTime.parse(match[1]), second = Number(match[2] || 0);
        var zoneHour = Number(match[6] || 0), zoneMinute = Number(match[7] || 0);
        if (!parsed || second > 59 || zoneHour > 23 || zoneMinute > 59) return null;
        var offset = (zoneHour * 60 + zoneMinute) * 60000 * (match[5] === '-' ? -1 : 1);
        var ms = parsed.ms + 8 * 3600000 - offset + second * 1000 + Number(((match[3] || '') + '000').slice(0, 3));
        return EquipTime.day(ms) ? ms : null;
    }

    /** Exactly the APP precedence: a truthy explicit status overrides doneAt. */
    function isDone(record) {
        var status = own(record, 'status');
        var doneAt = own(record, 'doneAt');
        return (status || (doneAt ? 'done' : 'open')) === 'done';
    }

    function compareText(left, right) {
        return left < right ? -1 : (left > right ? 1 : 0);
    }

    // Match the equipment-list key for normal metadata, but never coerce an
    // object/function or read an inherited property/accessor from input.
    function groupKeyOf(equipment) {
        var family = own(equipment, 'family');
        if (family && typeof family !== 'object' && typeof family !== 'function') return String(family).trim();
        var name = own(equipment, 'name');
        if (typeof name === 'string' && name) return name;
        var category = own(equipment, 'category') || 'prod';
        if (category === 'prod') return '生产设备';
        if (category === 'admin') return '行政设施';
        if (category === 'facility') return '系统设施';
        if (category === 'misc') return '事务杂项';
        return '未分类';
    }

    // Full own-content comparison, not work-order-number comparison. It also
    // handles frozen/cyclic input without serializing private fields into output.
    function sameContent(left, right, leftStack, rightStack) {
        if (left === right) return left !== 0 || 1 / left === 1 / right;
        if (typeof left === 'number' && typeof right === 'number' && left !== left && right !== right) return true;
        if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
        if (Array.isArray(left) !== Array.isArray(right)) return false;
        // Instances such as Date, Map or boxed Number can hide state outside
        // own properties. Distinct such instances are not safely deduplicable.
        // A custom inherited data object still compares by own content only.
        if (!Array.isArray(left)) {
            var leftConstructor = own(Object.getPrototypeOf(left), 'constructor');
            var rightConstructor = own(Object.getPrototypeOf(right), 'constructor');
            if ((typeof leftConstructor === 'function' && own(leftConstructor, 'name') !== 'Object')
                || (typeof rightConstructor === 'function' && own(rightConstructor, 'name') !== 'Object')) return false;
        }
        leftStack = leftStack || [];
        rightStack = rightStack || [];
        var prior = leftStack.indexOf(left);
        if (prior !== -1) return rightStack[prior] === right;
        if (rightStack.indexOf(right) !== -1) return false;
        leftStack.push(left);
        rightStack.push(right);
        var leftKeys = Object.getOwnPropertyNames(left).sort();
        var rightKeys = Object.getOwnPropertyNames(right).sort();
        if (typeof Object.getOwnPropertySymbols === 'function') {
            leftKeys = leftKeys.concat(Object.getOwnPropertySymbols(left));
            rightKeys = rightKeys.concat(Object.getOwnPropertySymbols(right));
        }
        var equal = leftKeys.length === rightKeys.length;
        for (var i = 0; equal && i < leftKeys.length; i++) {
            var key = leftKeys[i];
            if (typeof key === 'string' ? key !== rightKeys[i] : rightKeys.indexOf(key) === -1) {
                equal = false;
                break;
            }
            var a = Object.getOwnPropertyDescriptor(left, key);
            var b = Object.getOwnPropertyDescriptor(right, key);
            if (!b || hasOwn.call(a, 'value') !== hasOwn.call(b, 'value')) equal = false;
            else if (hasOwn.call(a, 'value')) equal = sameContent(a.value, b.value, leftStack, rightStack);
            else equal = a.get === b.get && a.set === b.set;
        }
        leftStack.pop();
        rightStack.pop();
        return equal;
    }

    function amount(value) {
        if (typeof value === 'string') {
            value = value.trim();
            // Decimal numeric strings only; no coercion of booleans, arrays, hex or blanks.
            if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return null;
            value = Number(value);
        }
        return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    }

    function inPeriod(time, start, end) {
        return time !== null && time >= start && time <= end;
    }

    function aging(waitingDays) {
        if (waitingDays === null) return '日期待核';
        if (waitingDays <= 3) return '0—3天';
        if (waitingDays <= 7) return '4—7天';
        if (waitingDays <= 14) return '8—14天';
        if (waitingDays <= 30) return '15—30天';
        return '超过30天';
    }

    function nextMonth(time) {
        var date = new Date(time);
        date.setUTCMonth(date.getUTCMonth() + 1, 1);
        return date.getTime();
    }

    // Only explicit registered values classify work; the legacy default "inner" is not confirmation.
    function serviceRecord(record, equipment, code, recordId, start, end) {
        var done = parseDate(own(record, 'doneAt'));
        if (!isDone(record) || !inPeriod(done, start, end)) return null;
        var report = parseDate(own(record, 'reportAt')), due = EquipTime.parse(own(record, 'expectedAt'));
        var mode = text(own(record, 'repairMode')).trim(), supplier = text(own(record, 'supplier')).trim();
        var handler = text(own(record, 'handler')).trim(), issues = [];
        if (mode !== 'inner' && mode !== 'outer') { mode = 'unknown'; issues.push('维修方式缺失或无效'); }
        if (mode === 'inner' && supplier) { mode = 'unknown'; issues.push('内部维修与外协名称矛盾'); }
        if (mode === 'outer' && !supplier) issues.push('外协供应商／人员未填');
        if (mode === 'inner' && !handler) issues.push('内部维修人未填');
        var cost = amount(own(record, 'cost'));
        if (cost === null) issues.push('登记费用缺失或无效');
        else if (cost === 0) issues.push('零元费用待核');
        var cycle = report !== null && report <= done ? (done - report) / DAY : null;
        var validDue = due && !(report !== null && due.day < formatDate(report)) && !(report !== null && report > done);
        if (cycle === null) issues.push('处理周期日期待核');
        if (!validDue) issues.push('延期状态待核');
        return { code: code, recordId: recordId, name: text(own(equipment, 'name')), department: text(own(equipment, 'line')),
            workOrder: text(own(record, 'no')), symptom: text(own(record, 'symptom')), mode: mode, handler: handler, supplier: supplier,
            reportAt: text(own(record, 'reportAt')), doneAt: text(own(record, 'doneAt')), cost: cost, cycleDays: cycle,
            delayed: validDue ? EquipTime.isDelayed(own(record, 'expectedAt'), own(record, 'doneAt')) : null, issues: issues };
    }
    function serviceGroup(label, records, total) {
        var costs = records.filter(function (r) { return r.cost !== null; });
        var cycles = records.filter(function (r) { return r.cycleDays !== null; });
        var due = records.filter(function (r) { return r.delayed !== null; });
        var sum = costs.reduce(function (n, r) { return n + r.cost; }, 0);
        return { label: label, count: records.length, share: total ? records.length / total : null,
            equipmentCount: new Set(records.map(function (r) { return r.code; })).size,
            registeredAmount: costs.length ? sum : null, amountN: costs.length,
            averageAmount: costs.length ? sum / costs.length : null, zeroAmountN: costs.filter(function (r) { return r.cost === 0; }).length,
            cycleDays: cycles.length ? cycles.reduce(function (n, r) { return n + r.cycleDays; }, 0) / cycles.length : null, cycleN: cycles.length,
            delayedCount: due.filter(function (r) { return r.delayed; }).length, dueN: due.length,
            delayedRate: due.length ? due.filter(function (r) { return r.delayed; }).length / due.length : null,
            issueCount: records.filter(function (r) { return r.issues.length; }).length, records: records };
    }
    function serviceAnalysis(records, type) {
        function groups(mode, field, fallback) {
            var map = new Map();
            records.forEach(function (r) {
                if (r.mode !== mode) return;
                var key = r[field] || fallback;
                if (!map.has(key)) map.set(key, []);
                map.get(key).push(r);
            });
            return Array.from(map, function (entry) { return serviceGroup(entry[0], entry[1], records.length); })
                .sort(function (a, b) { return b.count - a.count || compareText(a.label, b.label); });
        }
        return { type: type, total: records.length,
            modes: ['inner', 'outer', 'unknown'].map(function (mode) { return serviceGroup(mode, records.filter(function (r) { return r.mode === mode; }), records.length); }),
            employees: groups('inner', 'handler', '维修人未填'), suppliers: groups('outer', 'supplier', '外协名称未填') };
    }

    function addReasonGroup(groups, key, label, order) {
        var group = groups.get(key);
        if (!group) {
            group = { label: label, records: [], registeredAmount: null, amountN: 0 };
            groups.set(key, group);
        }
        group.records.push(order);
        if (order.cost !== null) {
            group.amountN++;
            group.registeredAmount = (group.registeredAmount || 0) + order.cost;
        }
    }

    function sortedReasonGroups(groups) {
        var rows = Array.from(groups.values());
        rows.forEach(function (group) {
            group.records.sort(function (a, b) {
                return compareText(b.doneAt, a.doneAt) || compareText(a.code, b.code) || compareText(a.recordId, b.recordId);
            });
        });
        return rows.sort(function (a, b) {
            return b.records.length - a.records.length || compareText(a.label, b.label);
        });
    }

    // Each list belongs to one physical asset and one complete classification.
    // Only strictly earlier completion days can establish the order of events.
    function findRepeatRepairs(history, start, end, matches) {
        history.forEach(function (orders) {
            orders.sort(function (a, b) { return a.report - b.report || compareText(a.recordId, b.recordId); });
            var completions = orders.filter(function (order) { return order.completed !== null; })
                .sort(function (a, b) { return a.completed - b.completed || a.report - b.report || compareText(a.recordId, b.recordId); });
            var next = 0;
            orders.forEach(function (order) {
                if (!inPeriod(order.report, start, end)) return;
                while (next < completions.length && completions[next].completed < order.report) next++;
                if (!next) return;
                var previous = completions[next - 1];
                var days = (order.report - previous.completed) / DAY;
                if (days <= 30) matches.push({ previous: previous, current: order, days: days });
            });
        });
    }

    function createTrends(start, end) {
        var daily = [], weekly = [], monthly = [], cursor, edge, date;
        for (cursor = start; cursor <= end; cursor += DAY) {
            daily.push({ label: formatDate(cursor), start: formatDate(cursor), end: formatDate(cursor), newCount: 0, completedCount: 0 });
        }
        cursor = start;
        while (cursor <= end) {
            date = new Date(cursor);
            edge = Math.min(end, cursor + ((7 - date.getUTCDay()) % 7) * DAY);
            weekly.push({ label: formatDate(cursor) + '—' + formatDate(edge), start: formatDate(cursor), end: formatDate(edge), newCount: 0, completedCount: 0 });
            cursor = edge + DAY;
        }
        cursor = start;
        while (cursor <= end) {
            edge = Math.min(end, nextMonth(cursor) - DAY);
            monthly.push({ label: formatDate(cursor).slice(0, 7), start: formatDate(cursor), end: formatDate(edge), newCount: 0, completedCount: 0 });
            cursor = edge + DAY;
        }
        return { daily: daily, weekly: weekly, monthly: monthly };
    }

    function addTrend(trends, date, key, periodStart) {
        var dayIndex = (date - periodStart) / DAY;
        trends.daily[dayIndex][key]++;
        var dateString = formatDate(date);
        ['weekly', 'monthly'].forEach(function (granularity) {
            var rows = trends[granularity];
            // Buckets are ordered and disjoint. Binary search avoids O(records * days).
            var low = 0, high = rows.length - 1;
            while (low <= high) {
                var mid = (low + high) >> 1;
                if (dateString < rows[mid].start) high = mid - 1;
                else if (dateString > rows[mid].end) low = mid + 1;
                else { rows[mid][key]++; break; }
            }
        });
    }

    /**
     * analyze(equipmentsMap, {asOf,start,end,asOfTime?,department:'',family:''})
     * - asOfTime: epoch ms or zoned ISO instant; omitted means Beijing asOf day-end.
     * - expectedAt accepts date or Beijing minute; reportAt/doneAt stay date-only.
     * - completion/cycle conclusions use registered dates, not invented hours.
     * - e.line -> department; r.no -> workOrder; r.cost -> registered amount.
     * - scope counts unique measurable records, after same-code ID resolution.
     * - duplicateCount counts removable extra rows; conflictCount counts excluded ID groups.
     * - quality covers all retained faults in the filtered scope, not just the selected period.
     * - invalidDateCount counts nonempty invalid date fields and impossible date relations.
     * - missingDueCount covers missing expectedAt on faults (completed or open).
     * - amount/cycle samples belong to doneAt in the selected period and require isDone.
     * - zero counts mean only "not observed in this input", not historical completeness.
     */
    function analyze(equipmentsMap, options) {
        if (!isObject(options)) throw new Error('分析选项必须包含 asOf、start、end 三个 YYYY-MM-DD 日期。');
        var asOfText = own(options, 'asOf'), startText = own(options, 'start'), endText = own(options, 'end');
        var asOf = parseDate(asOfText), start = parseDate(startText), end = parseDate(endText);
        if (asOf === null) throw new Error('asOf 日期无效：请使用真实的 YYYY-MM-DD 自然日。');
        if (start === null) throw new Error('start 日期无效：请使用真实的 YYYY-MM-DD 自然日。');
        if (end === null) throw new Error('end 日期无效：请使用真实的 YYYY-MM-DD 自然日。');
        if (start > end) throw new Error('日期区间倒序：start 不能晚于 end。');
        if (start > asOf || end > asOf) throw new Error('所选日期不能超过 asOf 截止日。');
        var rawAsOfTime = own(options, 'asOfTime');
        var asOfTime = rawAsOfTime === undefined ? EquipTime.parse(asOfText).ms : parseAsOfTime(rawAsOfTime);
        if (asOfTime === null) throw new Error('asOfTime 无效：请使用有限毫秒数或带时区的 ISO 时刻。');
        var departmentFilter = own(options, 'department');
        var familyFilter = own(options, 'family');
        if (departmentFilter !== undefined && typeof departmentFilter !== 'string') throw new Error('department 筛选必须是字符串。');
        if (familyFilter !== undefined && typeof familyFilter !== 'string') throw new Error('family 筛选必须是字符串。');
        departmentFilter = departmentFilter || '';
        familyFilter = familyFilter || '';
        var serviceType = own(options, 'serviceType') || 'fault';
        if (KNOWN_TYPES.indexOf(serviceType) === -1) throw new Error('维修执行分析的记录类型无效。');
        var serviceRecords = [];
        if (!isObject(equipmentsMap)) throw new Error('设备数据必须是已按当前账号权限过滤的设备映射对象。');

        var threeDate = new Date(end);
        threeDate.setUTCMonth(threeDate.getUTCMonth() - 2, 1);
        var threeStart = threeDate.getTime();
        var result = {
            period: { start: startText, end: endText, asOf: asOfText, threeStart: formatDate(threeStart) },
            scope: { equipmentCount: 0, recordCount: 0, faultCount: 0, genericFaultCount: 0, ignoredTypeCount: 0 },
            summary: {
                newCount: 0, completedCount: 0, backlogCount: 0, overdueCount: 0, unknownDueCount: 0,
                cycleDays: null, cycleN: 0, registeredAmount: null, amountN: 0, zeroAmountN: 0, unknownAmountN: 0
            },
            backlog: [], priority: [], generic: [], trends: createTrends(start, end), priorityGroups: [],
            quality: {
                completedClassMissing: 0, completedClassDenominator: 0, invalidDateCount: 0,
                missingReportCount: 0, missingDueCount: 0, unknownTypeCount: 0, missingIdCount: 0,
                duplicateCount: 0, conflictCount: 0, statusConflictCount: 0, malformedEquipmentCount: 0, issues: []
            }
        };
        var quality = result.quality, scope = result.scope, summary = result.summary;
        var cycleSum = 0, totalAmount = 0;
        var causes = new Map(), delays = new Map(), repeats = [], delayedCount = 0, unknownDeadlineCount = 0;
        var priorityGroupCounts = new Map(), priorityGroupKeys = new Map();

        function issue(message, code, recordId) {
            // Deliberately whitelist the output; never include snapshots, people or private fields.
            quality.issues.push({ text: message, code: code, recordId: recordId || '' });
        }

        function readRecordDate(record, key, code, recordId) {
            var raw = own(record, key);
            if (missing(raw)) return null;
            var expected = key === 'expectedAt' ? EquipTime.parse(raw) : null;
            var value = key === 'expectedAt' ? (expected ? parseDate(expected.day) : null) : parseDate(raw);
            if (value === null) {
                quality.invalidDateCount++;
                issue(key + ' 日期无效，请核实。', code, recordId);
            }
            return value;
        }

        Object.keys(equipmentsMap).sort(compareText).forEach(function (code) {
            var equipment = own(equipmentsMap, code);
            if (!isObject(equipment)) {
                // Without filterable metadata, do not count malformed values outside a requested scope.
                if (!departmentFilter && !familyFilter) {
                    quality.malformedEquipmentCount++;
                    issue('设备档案不是有效对象，已忽略。', code, '');
                }
                return;
            }
            var department = text(own(equipment, 'line'));
            var family = text(own(equipment, 'family'));
            if ((departmentFilter && departmentFilter !== department) || (familyFilter && familyFilter !== family)) return;
            scope.equipmentCount++;
            var generic = code.indexOf('GEN-') === 0;
            if (!generic) {
                var groupKey = groupKeyOf(equipment);
                priorityGroupKeys.set(code, groupKey);
                priorityGroupCounts.set(groupKey, (priorityGroupCounts.get(groupKey) || 0) + 1);
            }
            var row = {
                code: code, name: text(own(equipment, 'name')), department: department, family: family,
                newCount: 0, threeMonthNewCount: 0, completedCount: 0, backlogCount: 0,
                overdueCount: 0, maxWaitDays: null, registeredAmount: null
            };
            var rowAmount = 0, rowAmountN = 0, cardFaultCount = 0;
            var records = own(equipment, 'records');
            if (!Array.isArray(records)) {
                quality.malformedEquipmentCount++;
                issue('records 不是数组，已按零条记录处理。', code, '');
                return;
            }

            var groups = new Map(), standalone = [], repeatHistory = new Map();
            Object.keys(records).forEach(function (sourceKey) {
                // Ignore inherited array entries and non-index auxiliary properties.
                if (!/^(0|[1-9]\d*)$/.test(sourceKey) || Number(sourceKey) >= records.length) return;
                var record = own(records, sourceKey);
                if (!isObject(record)) {
                    issue('记录不是有效对象，已忽略（源索引 ' + sourceKey + '）。', code, '@index:' + sourceKey);
                    return;
                }
                var id = own(record, 'id');
                var validId = nonblank(id) || (typeof id === 'number' && Number.isFinite(id));
                var entry = { record: record, recordId: validId ? String(id) : '@index:' + sourceKey, index: Number(sourceKey) };
                if (!validId) {
                    quality.missingIdCount++;
                    issue('记录缺少有效 ID，按源索引保留计数。', code, entry.recordId);
                    standalone.push(entry);
                } else {
                    var group = groups.get(id);
                    if (!group) { group = []; groups.set(id, group); }
                    group.push(entry);
                }
            });
            groups.forEach(function (group) {
                var equal = true;
                for (var i = 1; i < group.length; i++) {
                    if (!sameContent(group[0].record, group[i].record)) { equal = false; break; }
                }
                if (!equal) {
                    quality.conflictCount++;
                    issue('同 ID 内容冲突，整组 ' + group.length + ' 条记录已排除计量。', code, group[0].recordId);
                } else {
                    standalone.push(group[0]);
                    if (group.length > 1) {
                        quality.duplicateCount += group.length - 1;
                        issue('同 ID 同内容重复，已去除 ' + (group.length - 1) + ' 条额外记录。', code, group[0].recordId);
                    }
                }
            });
            standalone.sort(function (a, b) { return a.index - b.index; });
            standalone.forEach(function (entry) {
                var record = entry.record, recordId = entry.recordId;
                scope.recordCount++;
                var type = own(record, 'type');
                if (type === serviceType) {
                    var service = serviceRecord(record, equipment, code, recordId, start, end);
                    if (service) serviceRecords.push(service);
                }
                if (type !== 'fault') {
                    scope.ignoredTypeCount++;
                    if (KNOWN_TYPES.indexOf(type) === -1) {
                        quality.unknownTypeCount++;
                        issue('记录类型为空或未知，未按故障计入分析。', code, recordId);
                    }
                    return;
                }
                scope.faultCount++;
                cardFaultCount++;
                if (generic) scope.genericFaultCount++;
                var done = isDone(record);
                var status = own(record, 'status'), rawDone = own(record, 'doneAt');
                if ((status && status !== 'done' && rawDone) || (status === 'done' && !rawDone)) {
                    quality.statusConflictCount++;
                    issue('状态与完成日期矛盾，状态按 APP 的显式 status 优先规则判定。', code, recordId);
                }
                if (missing(own(record, 'reportAt'))) {
                    quality.missingReportCount++;
                    issue('故障缺少报修日期，无法确认新增或等待天数。', code, recordId);
                }
                if (missing(own(record, 'expectedAt'))) {
                    quality.missingDueCount++;
                    issue('故障缺少预计完成日期。', code, recordId);
                }
                var report = readRecordDate(record, 'reportAt', code, recordId);
                var due = readRecordDate(record, 'expectedAt', code, recordId);
                var completed = readRecordDate(record, 'doneAt', code, recordId);
                if (report !== null && report > asOf) {
                    quality.invalidDateCount++;
                    issue('报修日期晚于 asOf，等待天数待核。', code, recordId);
                }
                if (completed !== null && completed > asOf) {
                    quality.invalidDateCount++;
                    issue('完成日期晚于 asOf，未计入本期完成。', code, recordId);
                }
                var reversedCycle = report !== null && completed !== null && completed < report;
                if (reversedCycle) {
                    quality.invalidDateCount++;
                    issue('完成日期早于报修日期，未计入维修周期样本。', code, recordId);
                }
                var reversedDue = report !== null && due !== null && due < report;
                if (reversedDue) {
                    quality.invalidDateCount++;
                    issue('预计完成日期早于报修日期，逾期状态待核。', code, recordId);
                }
                var classification = ['cause1', 'cause2', 'cause3'].map(function (field) { return text(own(record, field)).trim(); });
                var classified = classification.every(Boolean), classKey = classified ? JSON.stringify(classification) : '';
                var classLabel = classified ? classification.join(' / ') : '分类待补全';
                if (!generic && classified && report !== null && report <= end && !reversedCycle &&
                    (report >= start || (done && inPeriod(completed, start - 30 * DAY, end)))) {
                    if (!repeatHistory.has(classKey)) repeatHistory.set(classKey, []);
                    repeatHistory.get(classKey).push({
                        code: code, name: row.name, department: department, recordId: recordId, workOrder: text(own(record, 'no')),
                        classification: classLabel, report: report, completed: done ? completed : null
                    });
                }
                if (done) {
                    quality.completedClassDenominator++;
                    if (!classified) {
                        quality.completedClassMissing++;
                        issue('已完成故障的三级分类未全部填写。', code, recordId);
                    }
                    if (completed === null && missing(rawDone)) issue('已完成故障缺少完成日期，未计入期间完成与金额。', code, recordId);
                }
                if (inPeriod(report, start, end)) {
                    summary.newCount++;
                    row.newCount++;
                    addTrend(result.trends, report, 'newCount', start);
                }
                if (inPeriod(report, threeStart, end)) row.threeMonthNewCount++;
                if (done && inPeriod(completed, start, end)) {
                    summary.completedCount++;
                    row.completedCount++;
                    addTrend(result.trends, completed, 'completedCount', start);
                    if (report !== null && !reversedCycle) {
                        cycleSum += (completed - report) / DAY;
                        summary.cycleN++;
                    }
                    var cost = amount(own(record, 'cost'));
                    var order = { code: code, name: row.name, department: department, recordId: recordId, workOrder: text(own(record, 'no')),
                        doneAt: rawDone, expectedAt: text(own(record, 'expectedAt')), cost: cost };
                    addReasonGroup(causes, classKey, classLabel, order);
                    if (due === null || reversedDue || reversedCycle) {
                        unknownDeadlineCount++;
                    } else if (EquipTime.isDelayed(order.expectedAt, rawDone)) {
                        var reason = text(own(record, 'delayReason')).trim();
                        addReasonGroup(delays, reason, reason || '原因未填', order);
                        delayedCount++;
                    }
                    if (cost === null) {
                        summary.unknownAmountN++;
                        issue('本期完成故障的登记金额缺失或无效，未计入金额合计。', code, recordId);
                    } else {
                        totalAmount += cost;
                        rowAmount += cost;
                        summary.amountN++;
                        rowAmountN++;
                        if (cost === 0) {
                            summary.zeroAmountN++;
                            issue('本期完成故障登记金额为 0，费用是否完整待核实。', code, recordId);
                        }
                    }
                }
                if (!done) {
                    summary.backlogCount++;
                    row.backlogCount++;
                    var wait = report !== null && report <= asOf ? (asOf - report) / DAY : null;
                    var dueKnown = due !== null && report !== null && report <= asOf && !reversedDue;
                    var expected = dueKnown ? EquipTime.parse(own(record, 'expectedAt')) : null;
                    var overdueTime = dueKnown ? EquipTime.overdueMs(expected.value, asOfTime) : null;
                    var overdue = !dueKnown ? 'unknown' : (overdueTime > 0 ? 'overdue' : 'not-overdue');
                    // Preserve legacy natural-day values exactly; only minute deadlines have elapsed fractions.
                    var overdueDays = dueKnown ? (expected.kind === 'date' ? Math.max(0, (asOf - due) / DAY) : overdueTime / DAY) : null;
                    if (overdue === 'overdue') { summary.overdueCount++; row.overdueCount++; }
                    if (overdue === 'unknown') summary.unknownDueCount++;
                    if (wait !== null && (row.maxWaitDays === null || wait > row.maxWaitDays)) row.maxWaitDays = wait;
                    result.backlog.push({
                        code: code, name: row.name, department: department, recordId: recordId,
                        workOrder: text(own(record, 'no')), reportAt: text(own(record, 'reportAt')),
                        expectedAt: text(own(record, 'expectedAt')), waitingDays: wait, overdueDays: overdueDays,
                        overdue: overdue, symptom: text(own(record, 'symptom')), aging: aging(wait)
                    });
                }
            });
            findRepeatRepairs(repeatHistory, start, end, repeats);
            row.registeredAmount = rowAmountN ? rowAmount : null;
            if (generic) {
                if (cardFaultCount) {
                    row.genericFaultCount = cardFaultCount;
                    result.generic.push(row);
                }
            } else if (row.threeMonthNewCount || row.completedCount || row.backlogCount) {
                result.priority.push(row);
            }
        });

        summary.cycleDays = summary.cycleN ? cycleSum / summary.cycleN : null;
        summary.registeredAmount = summary.amountN ? totalAmount : null;
        function priorityOrder(a, b) {
            return b.threeMonthNewCount - a.threeMonthNewCount || b.backlogCount - a.backlogCount
                || b.newCount - a.newCount || compareText(a.code, b.code);
        }
        result.priority.sort(priorityOrder);
        var priorityGroups = new Map();
        result.priority.forEach(function (row) {
            var name = priorityGroupKeys.get(row.code);
            var group = priorityGroups.get(name);
            if (!group) {
                group = {
                    name: name, equipmentCount: priorityGroupCounts.get(name), activeEquipmentCount: 0,
                    newCount: 0, threeMonthNewCount: 0, backlogCount: 0, overdueCount: 0, devices: []
                };
                priorityGroups.set(name, group);
                result.priorityGroups.push(group);
            }
            group.devices.push(row);
            group.activeEquipmentCount++;
            group.newCount += row.newCount;
            group.threeMonthNewCount += row.threeMonthNewCount;
            group.backlogCount += row.backlogCount;
            group.overdueCount += row.overdueCount;
        });
        result.priorityGroups.sort(function (a, b) {
            return b.threeMonthNewCount - a.threeMonthNewCount || b.backlogCount - a.backlogCount
                || b.newCount - a.newCount || compareText(a.name, b.name);
        });
        result.generic.sort(function (a, b) { return compareText(a.department, b.department) || priorityOrder(a, b); });
        result.backlog.sort(function (a, b) {
            var rank = { overdue: 0, 'not-overdue': 1, unknown: 2 };
            return rank[a.overdue] - rank[b.overdue]
                || (b.waitingDays === null ? -1 : b.waitingDays) - (a.waitingDays === null ? -1 : a.waitingDays)
                || compareText(a.code, b.code) || compareText(a.recordId, b.recordId);
        });
        serviceRecords.sort(function (a, b) { return compareText(b.doneAt, a.doneAt) || compareText(a.code, b.code) || compareText(a.recordId, b.recordId); });
        result.services = serviceAnalysis(serviceRecords, serviceType);
        repeats.sort(function (a, b) {
            return b.current.report - a.current.report || compareText(a.current.code, b.current.code) || compareText(a.current.recordId, b.current.recordId);
        });
        result.faultInsights = { causes: sortedReasonGroups(causes), delays: sortedReasonGroups(delays), repeats: repeats,
            delayedCount: delayedCount, unknownDeadlineCount: unknownDeadlineCount };
        return result;
    }

    return { analyze: analyze, parseDate: parseDate, isDone: isDone, groupKeyOf: groupKeyOf };
}));
