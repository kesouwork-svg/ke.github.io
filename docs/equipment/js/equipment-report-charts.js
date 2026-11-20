/* Add editable DrawingML charts to the XLSX package produced by the bundled SheetJS writer. */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.EquipReportCharts = factory();
}(typeof window === 'undefined' ? globalThis : window, function () {
    'use strict';
    const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const drawing = 'http://schemas.openxmlformats.org/drawingml/2006/';
    const relationships = 'http://schemas.openxmlformats.org/package/2006/relationships';
    const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    const colors = ['23679B', '0E827C', '9A7142'];
    function escapeXml(value) {
        return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function reference(book, spec, col, numeric) {
        const ws = book.Sheets[spec.source];
        const end = spec.first + spec.n - 1, ref = "'" + spec.source + "'!$" + col + '$' + spec.first + ':$' + col + '$' + end;
        let points = '';
        for (let i = 0; i < spec.n; i++) {
            const cell = ws[col + (spec.first + i)];
            if (cell && cell.v != null) points += '<c:pt idx="' + i + '"><c:v>' + escapeXml(cell.v) + '</c:v></c:pt>';
        }
        const type = numeric ? 'num' : 'str';
        return '<c:' + type + 'Ref><c:f>' + escapeXml(ref) + '</c:f><c:' + type + 'Cache>'
            + (numeric ? '<c:formatCode>General</c:formatCode>' : '') + '<c:ptCount val="' + spec.n + '"/>'
            + points + '</c:' + type + 'Cache></c:' + type + 'Ref>';
    }
    function fill(color) { return '<a:solidFill><a:srgbClr val="' + color + '"/></a:solidFill>'; }
    function series(book, spec, item, i) {
        let style = '<c:spPr>' + fill(colors[i]) + '</c:spPr>';
        if (spec.kind === 'line') {
            style = '<c:spPr><a:ln w="28575">' + fill(colors[i]) + '</a:ln></c:spPr>'
                + '<c:marker><c:symbol val="circle"/><c:size val="4"/><c:spPr>' + fill(colors[i]) + '<a:ln>' + fill(colors[i]) + '</a:ln></c:spPr></c:marker>';
        } else if (spec.kind === 'ring') {
            style = colors.map((c, n) => '<c:dPt><c:idx val="' + n + '"/><c:spPr>' + fill(c) + '</c:spPr></c:dPt>').join('');
        }
        return '<c:ser><c:idx val="' + i + '"/><c:order val="' + i + '"/><c:tx><c:v>' + escapeXml(item[1])
            + '</c:v></c:tx>' + style + '<c:cat>' + reference(book, spec, spec.cat, false) + '</c:cat><c:val>'
            + reference(book, spec, item[0], true) + '</c:val>' + (spec.kind === 'line' ? '<c:smooth val="0"/>' : '') + '</c:ser>';
    }
    function axes(book, spec) {
        const horizontal = spec.kind === 'bar';
        const smallCounts = (horizontal || spec.series.length === 2) && spec.series.every(([col]) => {
            const sheet = book.Sheets[spec.source];
            for (let n = 0; n < spec.n; n++) if (sheet[col + (spec.first + n)]?.v > 6) return false;
            return true;
        });
        return '<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="' + (horizontal ? 'maxMin' : 'minMax')
            + '"/></c:scaling><c:delete val="0"/><c:axPos val="' + (horizontal ? 'l' : 'b') + '"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="low"/>'
            + '<c:crossAx val="2"/><c:crosses val="autoZero"/><c:tickLblSkip val="' + Math.max(1, Math.ceil(spec.n / 12))
            + '"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/><c:min val="0"/></c:scaling>'
            + '<c:delete val="0"/><c:axPos val="' + (horizontal ? 'b' : 'l') + '"/><c:majorGridlines><c:spPr><a:ln>' + fill('DFE8EE')
            + '</a:ln></c:spPr></c:majorGridlines><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="1"/><c:crosses val="'
            + (horizontal ? 'max' : 'autoZero') + '"/><c:crossBetween val="between"/>' + (smallCounts ? '<c:majorUnit val="1"/>' : '') + '</c:valAx>';
    }
    function chartXml(book, spec) {
        const ring = spec.kind === 'ring', line = spec.kind === 'line';
        const tag = ring ? 'doughnutChart' : line ? 'lineChart' : 'barChart';
        let config = '<c:varyColors val="1"/>';
        if (!ring) config = line ? '<c:grouping val="standard"/>' : '<c:barDir val="' + (spec.kind === 'bar' ? 'bar' : 'col') + '"/><c:grouping val="clustered"/>';
        let labels = '';
        if (ring || spec.kind === 'bar') labels = '<c:dLbls>' + (ring ? '' : '<c:dLblPos val="outEnd"/>')
            + '<c:showLegendKey val="0"/><c:showVal val="' + (ring ? 0 : 1) + '"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="' + (ring ? 1 : 0) + '"/></c:dLbls>';
        return xml + '<c:chartSpace xmlns:c="' + drawing + 'chart" xmlns:a="' + drawing + 'main"><c:lang val="zh-CN"/><c:chart>'
            + '<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="1400" b="1"/><a:t>'
            + escapeXml(spec.title) + '</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:plotArea><c:layout/><c:' + tag + '>'
            + config + spec.series.map((s,i) => series(book, spec, s, i)).join('') + labels
            + (ring ? '<c:holeSize val="55"/>' : '<c:axId val="1"/><c:axId val="2"/>') + '</c:' + tag + '>'
            + (ring ? '' : axes(book,spec)) + '</c:plotArea>'
            + (ring || spec.series.length > 1 ? '<c:legend><c:legendPos val="' + (ring ? 'r' : 'b') + '"/><c:layout/><c:overlay val="0"/></c:legend>' : '')
            + '<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>';
    }
    function frame(spec) {
        return xml + '<xdr:wsDr xmlns:xdr="' + drawing + 'spreadsheetDrawing" xmlns:a="' + drawing + 'main"><xdr:oneCellAnchor>'
            + '<xdr:from><xdr:col>0</xdr:col><xdr:colOff>38100</xdr:colOff><xdr:row>' + spec.top + '</xdr:row><xdr:rowOff>19050</xdr:rowOff></xdr:from>'
            + '<xdr:ext cx="7429500" cy="2619375"/><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="' + escapeXml(spec.title)
            + '"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>'
            + '<a:graphic><a:graphicData uri="' + drawing + 'chart"><c:chart xmlns:c="' + drawing + 'chart" xmlns:r="' + office
            + '" r:id="rIdChart"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>';
    }
    function relation(id, type, target) {
        return '<Relationship Id="' + id + '" Type="' + office + '/' + type + '" Target="' + target + '"/>';
    }
    const emptyRels = xml + '<Relationships xmlns="' + relationships + '"></Relationships>';
    function styledRows(sheetXml, bands, ids) {
        return sheetXml.replace(/<row\b[^>]*\br="(\d+)"[^>]*>[\s\S]*?<\/row>/g, (row, n) => {
            if (!bands[n]) return row;
            return row.replace(/<c\s+([^>]+)>/g, (_, attrs) => '<c ' + attrs.replace(/\s+s="\d+"/, '') + ' s="' + ids[bands[n]] + '">');
        });
    }
    function addStyles(styles) {
        function extend(tag, items) {
            let first;
            styles = styles.replace(new RegExp('<' + tag + ' count="(\\d+)">([\\s\\S]*?)</' + tag + '>'), (_, count, children) => {
                first = Number(count);
                return '<' + tag + ' count="' + (first + items.length) + '">' + children + items.join('') + '</' + tag + '>';
            });
            return first;
        }
        const font = extend('fonts', [['FFFFFF',17], ['FFFFFF',11], ['164666',11]].map(([rgb, size]) =>
            '<font><b/><sz val="' + size + '"/><color rgb="FF' + rgb + '"/><name val="Microsoft YaHei"/></font>'));
        const bg = extend('fills', ['173951','24686E','E5F3F4'].map(rgb =>
            '<fill><patternFill patternType="solid"><fgColor rgb="FF' + rgb + '"/><bgColor indexed="64"/></patternFill></fill>'));
        const first = extend('cellXfs', [0,1,2].map(i => '<xf numFmtId="0" fontId="' + (font+i) + '" fillId="' + (bg+i)
            + '" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>'));
        return {styles, ids:{title:first,heading:first+1,note:first+2}};
    }
    function bytes(XLSX, book) {
        const archive = XLSX.CFB, zip = archive.read(new Uint8Array(XLSX.write(book,{type:'array',bookType:'xlsx'})),{type:'buffer'});
        const encode = new TextEncoder(), decode = new TextDecoder();
        function get(path) { const entry = archive.find(zip, '/' + path); return entry ? decode.decode(entry.content) : ''; }
        function put(path, value) { archive.utils.cfb_add(zip, '/' + path, encode.encode(value)); }
        const theme = addStyles(get('xl/styles.xml'));
        put('xl/styles.xml',theme.styles);
        let types = get('[Content_Types].xml');
        book.SheetNames.forEach((name,index) => {
            const ws = book.Sheets[name], spec = ws['!reportChart'], n = index + 1;
            const path = 'xl/worksheets/sheet' + n + '.xml', relPath = 'xl/worksheets/_rels/sheet' + n + '.xml.rels';
            let body = styledRows(get(path), ws['!reportBands'], theme.ids);
            if (spec) {
                const chart = 'xl/charts/chart' + n + '.xml', draw = 'xl/drawings/drawing' + n + '.xml';
                put(chart, chartXml(book,spec)); put(draw,frame(spec));
                put('xl/drawings/_rels/drawing' + n + '.xml.rels', emptyRels.replace('</Relationships>',relation('rIdChart','chart','../charts/chart' + n + '.xml') + '</Relationships>'));
                put(relPath, (get(relPath) || emptyRels).replace('</Relationships>',relation('rIdDrawing','drawing','../drawings/drawing' + n + '.xml') + '</Relationships>'));
                body = body.replace('</worksheet>', '<drawing xmlns:r="' + office + '" r:id="rIdDrawing"/></worksheet>');
                types = types.replace('</Types>', '<Override PartName="/' + chart + '" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>'
                    + '<Override PartName="/' + draw + '" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>');
            }
            put(path,body);
        });
        put('[Content_Types].xml',types);
        return archive.write(zip,{fileType:'zip',type:'buffer',compression:true});
    }
    return { bytes };
}));
