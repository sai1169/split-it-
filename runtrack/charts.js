// Small dependency-free SVG charts with hover tooltips.

const Charts = (() => {
    const NS = 'http://www.w3.org/2000/svg';

    function el(name, attrs = {}, parent) {
        const n = document.createElementNS(NS, name);
        for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
        if (parent) parent.appendChild(n);
        return n;
    }

    function setup(container, height) {
        container.innerHTML = '';
        container.classList.add('chart', 'chart-wrap');
        const width = Math.max(container.clientWidth, 280);
        const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img' }, container);
        const tip = document.createElement('div');
        tip.className = 'tooltip';
        container.appendChild(tip);
        return { svg, tip, width };
    }

    function showTip(tip, container, x, y, value, label) {
        tip.replaceChildren();
        const strong = document.createElement('strong');
        strong.textContent = value;
        const span = document.createElement('span');
        span.className = 'muted';
        span.textContent = label;
        tip.append(strong, span);
        tip.style.display = 'block';
        const maxLeft = container.clientWidth - tip.offsetWidth;
        tip.style.left = `${Math.max(0, Math.min(maxLeft, x - tip.offsetWidth / 2))}px`;
        tip.style.top = `${Math.max(0, y - tip.offsetHeight - 8)}px`;
    }

    // A round tick step giving about four gridlines up to v.
    function niceStep(v) {
        if (v <= 0) return 1;
        const raw = v / 4;
        const mag = 10 ** Math.floor(Math.log10(raw));
        for (const m of [1, 2, 5, 10]) if (m * mag >= raw) return m * mag;
        return 10 * mag;
    }

    // data: [{ label, value, valueText, tipLabel }]
    function bars(container, data, { height = 200, goal = null, formatAxis = v => v } = {}) {
        const { svg, tip, width } = setup(container, height);
        const pad = { top: 12, right: 8, bottom: 24, left: 40 };
        const innerW = width - pad.left - pad.right;
        const innerH = height - pad.top - pad.bottom;
        const step = niceStep(Math.max(...data.map(d => d.value), goal || 0));
        const ticks = Math.max(1, Math.ceil(Math.max(...data.map(d => d.value), goal || 0) / step));
        const max = step * ticks;
        const y = v => pad.top + innerH - (v / max) * innerH;

        for (let i = 0; i <= ticks; i++) {
            const v = step * i;
            el('line', { class: 'gridline', x1: pad.left, x2: width - pad.right, y1: y(v), y2: y(v) }, svg);
            el('text', { class: 'axis-label', x: pad.left - 6, y: y(v) + 4, 'text-anchor': 'end' }, svg)
                .textContent = formatAxis(v);
        }

        const slot = innerW / data.length;
        const bw = Math.max(4, Math.min(36, slot - 2));
        const labelEvery = Math.ceil(data.length / Math.floor(innerW / 44));

        data.forEach((d, i) => {
            const x = pad.left + i * slot + (slot - bw) / 2;
            const top = y(d.value);
            const h = pad.top + innerH - top;
            const r = Math.min(4, bw / 2, h);
            // Rounded top, square base.
            const path = h > 0
                ? `M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${top + h} Z`
                : `M${x},${top} H${x + bw}`;
            // Hit target spans the whole column, not just the painted bar.
            const hit = el('rect', { x: pad.left + i * slot, y: pad.top, width: slot, height: innerH, fill: 'transparent' }, svg);
            const bar = el('path', { class: 'bar', d: path, tabindex: 0, 'aria-label': `${d.tipLabel}: ${d.valueText}` }, svg);
            const show = () => {
                bar.classList.add('hover');
                showTip(tip, container, (x + bw / 2) * container.clientWidth / width,
                    top * container.clientWidth / width, d.valueText, d.tipLabel);
            };
            const hide = () => { bar.classList.remove('hover'); tip.style.display = 'none'; };
            for (const n of [bar, hit]) {
                n.addEventListener('pointerenter', show);
                n.addEventListener('pointerleave', hide);
            }
            bar.addEventListener('focus', show);
            bar.addEventListener('blur', hide);

            if (i % labelEvery === 0 || i === data.length - 1) {
                el('text', { class: 'axis-label', x: x + bw / 2, y: height - 6, 'text-anchor': 'middle' }, svg)
                    .textContent = d.label;
            }
        });

        if (goal) {
            el('line', { class: 'goal-line', x1: pad.left, x2: width - pad.right, y1: y(goal), y2: y(goal) }, svg);
        }
    }

    // Area chart of ys against xs with a crosshair that snaps to the nearest point.
    function area(container, xs, ys, { height = 160, formatX = v => v, formatY = v => v, formatAxis = formatY } = {}) {
        const { svg, tip, width } = setup(container, height);
        const pad = { top: 12, right: 8, bottom: 24, left: 40 };
        const innerW = width - pad.left - pad.right;
        const innerH = height - pad.top - pad.bottom;
        const xMax = xs[xs.length - 1] || 1;
        let yMin = Math.min(...ys), yMax = Math.max(...ys);
        const span = Math.max(10, yMax - yMin);
        yMin = Math.floor((yMin - span * 0.1) / 5) * 5;
        yMax = Math.ceil((yMax + span * 0.1) / 5) * 5;
        const x = v => pad.left + (v / xMax) * innerW;
        const y = v => pad.top + innerH - ((v - yMin) / (yMax - yMin)) * innerH;

        for (let i = 0; i <= 3; i++) {
            const v = yMin + ((yMax - yMin) / 3) * i;
            el('line', { class: 'gridline', x1: pad.left, x2: width - pad.right, y1: y(v), y2: y(v) }, svg);
            el('text', { class: 'axis-label', x: pad.left - 6, y: y(v) + 4, 'text-anchor': 'end' }, svg)
                .textContent = formatAxis(v);
        }
        for (let i = 0; i <= 4; i++) {
            const v = (xMax / 4) * i;
            el('text', { class: 'axis-label', x: x(v), y: height - 6, 'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle' }, svg)
                .textContent = formatX(v);
        }

        const line = xs.map((v, i) => `${x(v).toFixed(1)},${y(ys[i]).toFixed(1)}`).join(' L');
        el('path', { class: 'area', d: `M${x(0)},${y(yMin)} L${line} L${x(xMax)},${y(yMin)} Z` }, svg);
        el('path', { class: 'line', d: `M${line}` }, svg);

        const cross = el('line', { class: 'crosshair', y1: pad.top, y2: pad.top + innerH, visibility: 'hidden' }, svg);
        const dot = el('circle', { r: 4, fill: 'var(--brand)', stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' }, svg);
        const hit = el('rect', { x: pad.left, y: pad.top, width: innerW, height: innerH, fill: 'transparent' }, svg);

        hit.addEventListener('pointermove', e => {
            const rect = svg.getBoundingClientRect();
            const scale = width / rect.width;
            const target = ((e.clientX - rect.left) * scale - pad.left) / innerW * xMax;
            let lo = 0, hi = xs.length - 1;
            while (hi - lo > 1) {
                const mid = (lo + hi) >> 1;
                if (xs[mid] < target) lo = mid; else hi = mid;
            }
            const i = Math.abs(xs[lo] - target) < Math.abs(xs[hi] - target) ? lo : hi;
            const px = x(xs[i]);
            cross.setAttribute('x1', px);
            cross.setAttribute('x2', px);
            cross.setAttribute('visibility', 'visible');
            dot.setAttribute('cx', px);
            dot.setAttribute('cy', y(ys[i]));
            dot.setAttribute('visibility', 'visible');
            showTip(tip, container, px / scale, y(ys[i]) / scale, formatY(ys[i]), formatX(xs[i]));
        });
        hit.addEventListener('pointerleave', () => {
            cross.setAttribute('visibility', 'hidden');
            dot.setAttribute('visibility', 'hidden');
            tip.style.display = 'none';
        });
    }

    return { bars, area };
})();
