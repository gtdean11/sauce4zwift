/*
 * Sauce Bezier and catmullRom spline routines.
 *
 * Most functions work with a simple intermediate language that's
 * based on SVG paths but with native types and objects for
 * easier manipulation.
 *
 * The paths can be sliced, reversed, measured and traced in JS
 * so everything works on the backend or frontend.
 */


export class CurvePath extends Array {
    constructor(path, {epsilon=0.001}={}) {
        super();
        // Prevent our prop(s) from showing up during enumeration..
        Object.defineProperties(this, {
            epsilon: {
                value: epsilon,
                writable: true,
                enumerable: false,
            }
        });
        if (path) {
            for (let i = 0; i < path.length; i++) {
                this.push(path[i]);
            }
        }
    }

    toSVGPath() {
        const svg = [];
        const xy = point => `${Math.round(point[0])},${Math.round(point[1])}`;
        for (let i = 1; i < this.length - 1; i++) {
            const x = this[i];
            if (i === 1) {
                svg.push(`M ${xy(x.end)}`);
            } else {
                if (x.cp1 && x.cp2) {
                    svg.push(`C ${xy(x.cp1)} ${xy(x.cp2)} ${xy(x.end)}`);
                } else {
                    svg.push(`L ${xy(x.end)}`);
                }
            }
        }
        return svg.join('\n');
    }

    flatten(t=0.01) {
        const values = [];
        this.trace(x => values.push(x.stepNode), t);
        return values;
    }

    boundsAtRoadTime(roadTime) {
        return this.boundsAtRoadPercent(this.roadTimeToPercent(roadTime));
    }

    boundsAtRoadPercent(roadPercent) {
        const [index, pct] = roadPathOffsets(roadPercent, this.length);
        let bounds;
        let prev;
        this.trace(x => {
            if (x.index === index) {
                if (x.step >= pct) {
                    const delta = x.step - pct;
                    if (!delta) {
                        bounds = {...x, point: x.stepNode, pointPercent: x.step};
                    } else {
                        const prevStep = prev ? prev.step : 0;
                        const p = (pct - prevStep) / (x.step - prevStep);
                        const point = pointOnLine(prev ? prev.stepNode : x.origin.end, x.stepNode, p);
                        bounds = {...x, point, pointPercent: pct};
                    }
                    return false;
                }
            } else if (x.index > index) {
                const p = (pct - prev.step) / (1 - prev.step);
                const point = pointOnLine(prev.stepNode, x.origin.end, p);
                bounds = {...prev, point, pointPercent: pct};
                return false;
            } else {
                return null; // skip to next node
            }
            prev = x;
        });
        return bounds;
    }

    reverse() {
        let cursor = this[this.length - 1].end;
        const output = [{end: cursor}];
        for (let i = this.length - 2; i >= 0; i--) {
            const p0 = this[i];
            const p1 = this[i + 1];
            cursor = p0.end;
            if (p1.cp1 && p1.cp2) {
                output.push({cp1: p1.cp2, cp2: p1.cp1, end: cursor});
            } else {
                output.push({end: cursor});
            }
        }
        return new CurvePath(output);
    }

    subpathAtRoadTimes(startRoadTime, endRoadTime) {
        const startRoadPercent = roadTimeToPercent(startRoadTime);
        const endRoadPercent = roadTimeToPercent(endRoadTime);
        return this.subpathAtRoadPercents(startRoadPercent, endRoadPercent);
    }

    subpathAtRoadPercents(startRoadPercent, endRoadPercent) {
        const start = this.boundsAtRoadPercent(startRoadPercent);
        const end = this.boundsAtRoadPercent(endRoadPercent);
        const subpath = [{end: start.point}];
        for (const x of this.slice(start.index + 1, end.index + 1)) {
            subpath.push({...x});
        }
        if (end.step) {
            subpath.push({...end.next, end: end.point});
        }
        return new CurvePath(subpath, {epsilon: this.epsilon});
    }

    extend(path) {
        if (!path.length) {
            return;
        }
        this.push({...path[0], cp1: undefined, cp2: undefined}); // XXX create new control points
        for (let i = 1; i < path.length; i++) {
            this.push(path[i]);
        }
    }

    pointAtRoadTime(roadTime) {
        return this.pointAtRoadPercent(roadTimeToPercent(roadTime));
    }

    pointAtRoadPercent(roadPercent) {
        const bounds = this.boundsAtRoadPercent(roadPercent);
        return bounds && bounds.point;
    }

    pointAtDistance(targetDistance) {
        let point;
        let dist = 0;
        let prevStep;
        this.trace(x => {
            const stepDist = prevStep ? vecDist(prevStep, x.stepNode) : 0;
            dist += stepDist;
            if (dist > targetDistance) {
                const diff = (dist - targetDistance) / stepDist;
                point = pointOnLine(x.stepNode, prevStep, diff);
                return false;
            } else if (dist === targetDistance) {
                point = x.stepNode;
                return false;
            }
            prevStep = x.stepNode;
        });
        return point;
    }

    distance() {
        let dist = 0;
        let prevStep;
        this.trace(x => {
            dist += prevStep ? vecDist(prevStep, x.stepNode) : 0;
            prevStep = x.stepNode;
        });
        return dist;
    }

    trace(callback, t) {
        // This would be better looking as a generator but it needs it to be fast.
        t = t || this.epsilon;
        for (let index = 0; index < this.length; index++) {
            const origin = this[index];
            const next = this[index + 1];
            if (next && next.cp1 && next.cp2) {
                for (let step = 0; step < 1; step += t) {
                    const stepNode = computeBezier(step, origin.end, next.cp1, next.cp2, next.end);
                    const op = callback({
                        origin,
                        next,
                        index,
                        stepNode,
                        step,
                    });
                    if (op === false) {
                        return;
                    } else if (op === null) {
                        break;
                    }
                }
            } else {
                const op = callback({
                    origin,
                    next,
                    index,
                    stepNode: origin.end,
                    step: 0,
                });
                if (op === false) {
                    return;
                }
            }
        }
    }
}


export function vecDist(a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}


/**
 * Original author: Nikolas Kyriakides
 * https://gist.github.com/nicholaswmin/c2661eb11cad5671d816
 *
 * Interpolates a Catmull-Rom Spline through a series of x/y points
 * Converts the CR Spline to Cubic Beziers for use with SVG items
 *
 * This is a simplified uniform (alpha=0) impl, as that is all Zwift uses.
 */
export function catmullRomPath(points, {loop, epsilon}={}) {
    if (loop) {
        points = Array.from(points);
        points.unshift(points[points.length - 1]);
        points.push(...points.slice(1, 3));
    }
    const start = 0;
    const end = points.length - 1;
    const path = [{end: points[start]}];
    for (let i = start; i < end; i++) {
        const p_1 = points[i - 1];
        const p0 = points[i];
        const p1 = points[i + 1];
        const p2 = points[i + 2];
        const meta = p0[3];
        const straight = meta?.straight;
        if (straight) {
            path.push({end: p1});
            continue;
        }
        const A = 6;
        const B = 6;
        const N = 1 / 6;
        const M = 1 / 6;
        const cp1 = p_1 ? [
            (-p_1[0] + A * p0[0] + 1 * p1[0]) * N,
            (-p_1[1] + A * p0[1] + 1 * p1[1]) * N,
            (-p_1[2] + A * p0[2] + 1 * p1[2]) * N,
        ] : p0;
        const cp2 = p2 ? [
            (p0[0] + B * p1[0] - 1 * p2[0]) * M,
            (p0[1] + B * p1[1] - 1 * p2[1]) * M,
            (p0[2] + B * p1[2] - 1 * p2[2]) * M
        ] : p1;
        path.push({cp1, cp2, end: p1});
    }
    return new CurvePath(path, {epsilon});
}


function bezierControl(a, b, c, smoothing, invert=false) {
    const dx = c[0] - a[0];
    const dy = c[1] - a[1];
    const dz = c[2] - a[2];
    const distance = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx) + (invert ? Math.PI : 0);
    const length = distance * smoothing;
    return [
        b[0] + Math.cos(angle) * length,
        b[1] + Math.sin(angle) * length,
        b[2] + dz * (invert ? 1 : -1) * smoothing
    ];
}


export function cubicBezierPath(points, {loop, smoothing=0.2, epsilon}={}) {
    if (loop) {
        points = Array.from(points);
        points.unshift(points[points.length - 1]);
        points.push(...points.slice(1, 3));
    }
    const start = 0;
    const end = points.length - 1;
    const path = [{end: points[start]}];
    for (let i = start; i < end; i++) {
        const p_1 = points[i - 1];
        const p0 = points[i];
        const p1 = points[i + 1];
        const p2 = points[i + 2];
        const meta = i ? p0[3] : null;
        const straight = meta?.straight;
        if (straight) {
            path.push({end: p1});
            continue;
        }
        const tanIn = p1[3]?.tanIn;
        const tanOut = p0[3]?.tanOut;
        const cp1 = tanOut ?
            [p0[0] + tanOut[0], p0[1] + tanOut[1], p0[2] + tanOut[2]] :
            p_1 ? bezierControl(p_1, p0, p1, smoothing) : p0;
        const cp2 = tanIn ?
            [p1[0] + tanIn[0], p1[1] + tanIn[1], p1[2] + tanIn[2]] :
            p2 ? bezierControl(p0, p1, p2, smoothing, true) : p1;
        path.push({cp1, cp2, end: p1});
    }
    return new CurvePath(path, {epsilon});
}


export function computeBezier(t, a, b, c, d) {
    const T = 1 - t;
    const x = T * T * T * a[0]
        + 3 * T * T * t * b[0]
        + 3 * T * t * t * c[0]
        + t * t * t * d[0];
    const y = T * T * T * a[1]
        + 3 * T * T * t * b[1]
        + 3 * T * t * t * c[1]
        + t * t * t * d[1];
    const z = T * T * T * a[2]
        + 3 * T * T * t * b[2]
        + 3 * T * t * t * c[2]
        + t * t * t * d[2];
    return [x, y, z];
}


export function pointOnLine(a, b, t) {
    // t is from 0 -> 1 where 0 = a and 1 = b
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    const angle = Math.atan2(dy, dx);
    const l = Math.sqrt(dx * dx + dy * dy) * t;
    return [
        a[0] + Math.cos(angle) * l,
        a[1] + Math.sin(angle) * l,
        a[2] + dz * t
    ];
}


export function roadTimeToPercent(roadTime) {
    return (roadTime - 5000) / 1e6;
}


export function roadPathOffsets(roadPercent, length) {
    const offt = roadPercent * (length - 3) + 1;
    return [offt | 0, offt % 1];
}


export function roadPercentAtOffset(i, length) {
    return (i - 1) / (length - 3);
}


export function roadTimeAtOffset(i, length) {
    roadPercentAtOffset(i, length) * 1e6 + 5000;
}
