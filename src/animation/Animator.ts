/**
 * @module echarts/animation/Animator
 */

import Clip from './Clip';
import * as color from '../tool/color';
import {isArrayLike, isFunction, isNumber, keys, logError, map} from '../core/util';
import {ArrayLike, Dictionary} from '../core/types';
import easingFuncs, { AnimationEasing } from './easing';
import Animation from './Animation';
import { createCubicEasingFunc } from './cubicEasing';

type NumberArray = ArrayLike<number>
type InterpolatableType = string | number | NumberArray | NumberArray[];

const arraySlice = Array.prototype.slice;

export function interpolateNumber(p0: number, p1: number, percent: number): number {
    return (p1 - p0) * percent + p0;
}

export function step(p0: any, p1: any, percent: number): any {
    return percent > 0.5 ? p1 : p0;
}

export function interpolate1DArray(
    out: NumberArray,
    p0: NumberArray,
    p1: NumberArray,
    percent: number
) {
    // TODO Handling different length TypedArray
    const len = p0.length;
    for (let i = 0; i < len; i++) {
        out[i] = interpolateNumber(p0[i], p1[i], percent);
    }
}

export function interpolate2DArray(
    out: NumberArray[],
    p0: NumberArray[],
    p1: NumberArray[],
    percent: number
) {
    const len = p0.length;
    // TODO differnt length on each item?
    const len2 = len && p0[0].length;
    for (let i = 0; i < len; i++) {
        if (!out[i]) {
            out[i] = [];
        }
        for (let j = 0; j < len2; j++) {
            out[i][j] = interpolateNumber(p0[i][j], p1[i][j], percent);
        }
    }
}

function add1DArray(
    out: NumberArray,
    p0: NumberArray,
    p1: NumberArray,
    sign: 1 | -1
) {
    const len = p0.length;
    for (let i = 0; i < len; i++) {
        out[i] = p0[i] + p1[i] * sign;
    }
    return out;
}

function add2DArray(
    out: NumberArray[],
    p0: NumberArray[],
    p1: NumberArray[],
    sign: 1 | -1
) {
    const len = p0.length;
    const len2 = len && p0[0].length;
    for (let i = 0; i < len; i++) {
        if (!out[i]) {
            out[i] = [];
        }
        for (let j = 0; j < len2; j++) {
            out[i][j] = p0[i][j] + p1[i][j] * sign;
        }
    }
    return out;
}
// arr0 is source array, arr1 is target array.
// Do some preprocess to avoid error happened when interpolating from arr0 to arr1
function fillArray(
    val0: NumberArray | NumberArray[],
    val1: NumberArray | NumberArray[],
    arrDim: number
) {
    // TODO Handling different length TypedArray
    let arr0 = val0 as (number | number[])[];
    let arr1 = val1 as (number | number[])[];
    if (!arr0.push || !arr1.push) {
        return;
    }
    const arr0Len = arr0.length;
    const arr1Len = arr1.length;
    if (arr0Len !== arr1Len) {
        // FIXME Not work for TypedArray
        const isPreviousLarger = arr0Len > arr1Len;
        if (isPreviousLarger) {
            // Cut the previous
            arr0.length = arr1Len;
        }
        else {
            // Fill the previous
            for (let i = arr0Len; i < arr1Len; i++) {
                arr0.push(arrDim === 1 ? arr1[i] : arraySlice.call(arr1[i]));
            }
        }
    }
    // Handling NaN value
    const len2 = arr0[0] && (arr0[0] as number[]).length;
    for (let i = 0; i < arr0.length; i++) {
        if (arrDim === 1) {
            if (isNaN(arr0[i] as number)) {
                arr0[i] = arr1[i];
            }
        }
        else {
            for (let j = 0; j < len2; j++) {
                if (isNaN((arr0 as number[][])[i][j])) {
                    (arr0 as number[][])[i][j] = (arr1 as number[][])[i][j];
                }
            }
        }
    }
}

function is1DArraySame(arr0: NumberArray, arr1: NumberArray) {
    const len = arr0.length;
    if (len !== arr1.length) {
        return false;
    }
    for (let i = 0; i < len; i++) {
        if (arr0[i] !== arr1[i]) {
            return false;
        }
    }
    return true;
}

export function cloneValue(value: InterpolatableType) {
    if (isArrayLike(value)) {
        const len = value.length;
        if (isArrayLike(value[0])) {
            const ret = [];
            for (let i = 0; i < len; i++) {
                ret.push(arraySlice.call(value[i]));
            }
            return ret;
        }

        return arraySlice.call(value);
    }

    return value;
}

function rgba2String(rgba: number[]): string {
    rgba[0] = Math.floor(rgba[0]);
    rgba[1] = Math.floor(rgba[1]);
    rgba[2] = Math.floor(rgba[2]);

    return 'rgba(' + rgba.join(',') + ')';
}

function guessArrayDim(value: ArrayLike<unknown>): number {
    return isArrayLike(value && (value as ArrayLike<unknown>)[0]) ? 2 : 1;
}

type Keyframe = {
    time: number
    value: unknown
    percent: number

    easing?: AnimationEasing    // Raw easing
    easingFunc?: (percent: number) => number
    additiveValue?: unknown
}

let tmpRgba: number[] = [0, 0, 0, 0];
class Track {

    keyframes: Keyframe[] = []

    propName: string

    // Larger than 0 if value is array
    arrDim: number = 0
    isColor: boolean

    interpolable: boolean = true

    private _finished: boolean

    private _needsSort: boolean = false

    private _additiveTrack: Track
    // Temporal storage for interpolated additive value.
    private _additiveValue: unknown

    // Info for run
    /**
     * Last frame
     */
    private _lastFr = 0
    /**
     * Percent of last frame.
     */
    private _lastFrP = 0

    constructor(propName: string) {
        this.propName = propName;
    }

    isFinished() {
        return this._finished;
    }

    setFinished() {
        this._finished = true;
        // Also set additive track to finished.
        // Make sure the final value stopped on the latest track
        if (this._additiveTrack) {
            this._additiveTrack.setFinished();
        }
    }

    needsAnimate() {
        return this.keyframes.length >= 2
             && this.interpolable;
    }

    getAdditiveTrack() {
        return this._additiveTrack;
    }

    addKeyframe(time: number, value: unknown, easing?: AnimationEasing) {
        this._needsSort = true;

        let keyframes = this.keyframes;
        let len = keyframes.length;

        if (this.interpolable) {
            // Handling values only if it's possible to be interpolated.
            if (isArrayLike(value)) {
                let arrayDim = guessArrayDim(value);
                if (len > 0 && this.arrDim !== arrayDim) { // Two values has differnt dimension.
                    this.interpolable = false;
                    return;
                }
                // Not a number array.
                if (arrayDim === 1 && !isNumber(value[0])
                    || arrayDim === 2 && !isNumber(value[0][0])) {
                    this.interpolable = false;
                    return;
                }
                if (len > 0) {
                    let lastFrame = keyframes[len - 1];

                    // For performance consideration. only check 1d array
                    if (arrayDim === 1 && is1DArraySame(value, lastFrame.value as number[])) {
                        // Ignore this frame.
                        return;
                    }
                }
                this.arrDim = arrayDim;
            }
            else {
                if (this.arrDim > 0) {  // Previous value is array.
                    this.interpolable = false;
                    return;
                }

                if (typeof value === 'string') {
                    const colorArray = color.parse(value);
                    if (colorArray) {
                        value = colorArray;
                        this.isColor = true;
                    }
                    else {
                        this.interpolable = false;
                    }
                }
                else if (typeof value !== 'number' || isNaN(value)) {
                    this.interpolable = false;
                    return;
                }

                if (len > 0) {
                    let lastFrame = keyframes[len - 1];
                    if (lastFrame.value === value
                        || this.isColor && is1DArraySame(lastFrame.value as number[], value as number[])
                    ) {
                        // Ignore this frame.
                        return;
                    }
                }
            }
        }

        const kf: Keyframe = {
            time,
            value,
            percent: 0
        };
        if (easing) {
            // Save the raw easing name to be used in css animation output
            kf.easing = easing;
            kf.easingFunc = isFunction(easing)
                ? easing
                : easingFuncs[easing] || createCubicEasingFunc(easing);
        }
        // Not check if value equal here.
        keyframes.push(kf);
        return kf;
    }

    prepare(maxTime: number, additiveTrack?: Track) {
        let kfs = this.keyframes;
        if (this._needsSort) {
            // Sort keyframe as ascending
            kfs.sort(function (a: Keyframe, b: Keyframe) {
                return a.time - b.time;
            });
        }

        const arrDim = this.arrDim;
        const kfsLen = kfs.length;
        const lastKf = kfs[kfsLen - 1];

        for (let i = 0; i < kfsLen; i++) {
            kfs[i].percent = kfs[i].time / maxTime;

            if (arrDim > 0 && i !== kfsLen - 1) {
                // Align array with target frame.
                fillArray(kfs[i].value as NumberArray, lastKf.value as NumberArray, arrDim);
            }
        }

        // Only apply additive animaiton on INTERPOLABLE SAME TYPE values.
        if (additiveTrack
            // If two track both will be animated and have same value format.
            && this.needsAnimate()
            && additiveTrack.needsAnimate()
            && arrDim === additiveTrack.arrDim
            && this.isColor === additiveTrack.isColor
            && !additiveTrack._finished
        ) {
            this._additiveTrack = additiveTrack;

            const startValue = kfs[0].value;
            // Calculate difference
            for (let i = 0; i < kfsLen; i++) {
                if (arrDim === 0) {
                    if (this.isColor) {
                        kfs[i].additiveValue =
                            add1DArray([], kfs[i].value as NumberArray, startValue as NumberArray, -1);
                    }
                    else {
                        kfs[i].additiveValue = kfs[i].value as number - (startValue as number);
                    }
                }
                else if (arrDim === 1) {
                    kfs[i].additiveValue = add1DArray(
                        [],
                        kfs[i].value as NumberArray,
                        startValue as NumberArray,
                        -1
                    );
                }
                else if (arrDim === 2) {
                    kfs[i].additiveValue = add2DArray(
                        [],
                        kfs[i].value as NumberArray[],
                        startValue as NumberArray[],
                        -1
                    );
                }
            }
        }
    }

    step(target: any, percent: number) {
        if (this._finished) {   // Track may be set to finished.
            return;
        }

        if (this._additiveTrack && this._additiveTrack._finished) {
            // Remove additive track if it's finished.
            this._additiveTrack = null;
        }
        const isAdditive = this._additiveTrack != null;
        const valueKey = isAdditive ? 'additiveValue' : 'value';

        const keyframes = this.keyframes;
        const kfsNum = keyframes.length;
        const propName = this.propName;
        const arrDim = this.arrDim;
        const isValueColor = this.isColor;
        // Find the range keyframes
        // kf1-----kf2---------current--------kf3
        // find kf2 and kf3 and do interpolation
        let frameIdx;
        const lastFrame = this._lastFr;
        const min = Math.min;
        // In the easing function like elasticOut, percent may less than 0
        if (percent < 0) {
            frameIdx = 0;
        }
        else if (percent < this._lastFrP) {
            // Start from next key
            // PENDING start from lastFrame ?
            const start = min(lastFrame + 1, kfsNum - 1);
            for (frameIdx = start; frameIdx >= 0; frameIdx--) {
                if (keyframes[frameIdx].percent <= percent) {
                    break;
                }
            }
            frameIdx = min(frameIdx, kfsNum - 2);
        }
        else {
            for (frameIdx = lastFrame; frameIdx < kfsNum; frameIdx++) {
                if (keyframes[frameIdx].percent > percent) {
                    break;
                }
            }
            frameIdx = min(frameIdx - 1, kfsNum - 2);
        }

        let nextFrame = keyframes[frameIdx + 1];
        let frame = keyframes[frameIdx];

        // Defensive coding.
        if (!(frame && nextFrame)) {
            return;
        }

        this._lastFr = frameIdx;
        this._lastFrP = percent;

        const range = (nextFrame.percent - frame.percent);
        if (range === 0) {
            return;
        }
        let w = (percent - frame.percent) / range;
        // Apply different easing of each keyframe.
        // Use easing specified in target frame.
        if (nextFrame.easingFunc) {
            w = nextFrame.easingFunc(w);
        }

        // If value is arr
        let targetArr = isAdditive ? this._additiveValue
            : (isValueColor ? tmpRgba : target[propName]);

        if ((arrDim > 0 || isValueColor) && !targetArr) {
            targetArr = this._additiveValue = [];
        }

        if (arrDim > 0) {
            arrDim === 1
                ? interpolate1DArray(
                    targetArr as NumberArray,
                    frame[valueKey] as NumberArray,
                    nextFrame[valueKey] as NumberArray,
                    w
                )
                : interpolate2DArray(
                    targetArr as NumberArray[],
                    frame[valueKey] as NumberArray[],
                    nextFrame[valueKey] as NumberArray[],
                    w
                );
        }
        else if (isValueColor) {
            interpolate1DArray(
                targetArr,
                frame[valueKey] as NumberArray,
                nextFrame[valueKey] as NumberArray,
                w
            );
            if (!isAdditive) {  // Convert to string later:)
                target[propName] = rgba2String(targetArr);
            }
        }
        else {
            let value;
            if (!this.interpolable) {
                // String is step(0.5)
                value = step(frame[valueKey], nextFrame[valueKey], w);
            }
            else {
                value = interpolateNumber(frame[valueKey] as number, nextFrame[valueKey] as number, w);
            }
            if (isAdditive) {
                this._additiveValue = value;
            }
            else {
                target[propName] = value;
            }
        }

        // Add additive to target
        if (isAdditive) {
            this._addToTarget(target);
        }
    }

    private _addToTarget(target: any) {
        const arrDim = this.arrDim;
        const propName = this.propName;
        const additiveValue = this._additiveValue;

        if (arrDim === 0) {
            if (this.isColor) {
                // TODO reduce unnecessary parse
                color.parse(target[propName], tmpRgba);
                add1DArray(tmpRgba, tmpRgba, additiveValue as NumberArray, 1);
                target[propName] = rgba2String(tmpRgba);
            }
            else {
                // Add a difference value based on the change of previous frame.
                target[propName] = target[propName] + additiveValue;
            }
        }
        else if (arrDim === 1) {
            add1DArray(target[propName], target[propName], additiveValue as NumberArray, 1);
        }
        else if (arrDim === 2) {
            add2DArray(target[propName], target[propName], additiveValue as NumberArray[], 1);
        }
    }
}


type DoneCallback = () => void;
type AbortCallback = () => void;
export type OnframeCallback<T> = (target: T, percent: number) => void;

export type AnimationPropGetter<T> = (target: T, key: string) => InterpolatableType;
export type AnimationPropSetter<T> = (target: T, key: string, value: InterpolatableType) => void;

export default class Animator<T> {

    animation?: Animation

    targetName?: string

    scope?: string

    __fromStateTransition?: string

    private _tracks: Dictionary<Track> = {}
    private _trackKeys: string[] = []

    private _target: T

    private _loop: boolean
    private _delay = 0
    private _maxTime = 0

    // Some status
    private _paused = false
    // 0: Not started
    // 1: Invoked started
    // 2: Has been run for at least one frame.
    private _started = 0

    private _additiveAnimators: Animator<any>[]

    private _doneCbs: DoneCallback[]
    private _onframeCbs: OnframeCallback<T>[]

    private _abortedCbs: AbortCallback[]

    private _clip: Clip = null

    constructor(target: T, loop: boolean, additiveTo?: Animator<any>[]) {
        this._target = target;
        this._loop = loop;
        if (loop && additiveTo) {
            logError('Can\' use additive animation on looped animation.');
            return;
        }
        this._additiveAnimators = additiveTo;
    }

    getMaxTime() {
        return this._maxTime;
    }
    getDelay() {
        return this._delay;
    }
    getLoop() {
        return this._loop;
    }

    getTarget() {
        return this._target;
    }

    /**
     * Target can be changed during animation
     * For example if style is changed during state change.
     * We need to change target to the new style object.
     */
    changeTarget(target: T) {
        this._target = target;
    }

    /**
     * Set Animation keyframe
     * @param time 关键帧时间，单位是ms
     * @param props 关键帧的属性值，key-value表示
     */
    when(time: number, props: Dictionary<any>, easing?: AnimationEasing) {
        return this.whenWithKeys(time, props, keys(props) as string[], easing);
    }


    // Fast path for add keyframes of aniamteTo
    whenWithKeys(time: number, props: Dictionary<any>, propNames: string[], easing?: AnimationEasing) {
        const tracks = this._tracks;
        for (let i = 0; i < propNames.length; i++) {
            const propName = propNames[i];

            let track = tracks[propName];
            if (!track) {
                track = tracks[propName] = new Track(propName);

                let initialValue;
                const additiveTrack = this._getAdditiveTrack(propName);
                if (additiveTrack) {
                    const lastFinalKf = additiveTrack.keyframes[additiveTrack.keyframes.length - 1];
                    // Use the last state of additived animator.
                    initialValue = lastFinalKf && lastFinalKf.value;
                    if (additiveTrack.isColor && initialValue) {
                        // Convert to rgba string
                        initialValue = rgba2String(initialValue as number[]);
                    }
                }
                else {
                    initialValue = (this._target as any)[propName];
                }
                // Invalid value
                if (initialValue == null) {
                    // zrLog('Invalid property ' + propName);
                    continue;
                }
                // If time is 0
                //  Then props is given initialize value
                // Else
                //  Initialize value from current prop value
                if (time !== 0) {
                    track.addKeyframe(0, cloneValue(initialValue), easing);
                }

                this._trackKeys.push(propName);
            }
            track.addKeyframe(time, cloneValue(props[propName]), easing);
        }
        this._maxTime = Math.max(this._maxTime, time);
        return this;
    }

    pause() {
        this._clip.pause();
        this._paused = true;
    }

    resume() {
        this._clip.resume();
        this._paused = false;
    }

    isPaused(): boolean {
        return !!this._paused;
    }

    private _doneCallback() {
        this._setTracksFinished();
        // Clear clip
        this._clip = null;

        const doneList = this._doneCbs;
        if (doneList) {
            const len = doneList.length;
            for (let i = 0; i < len; i++) {
                doneList[i].call(this);
            }
        }
    }
    private _abortedCallback() {
        this._setTracksFinished();

        const animation = this.animation;
        const abortedList = this._abortedCbs;

        if (animation) {
            animation.removeClip(this._clip);
        }
        this._clip = null;

        if (abortedList) {
            for (let i = 0; i < abortedList.length; i++) {
                abortedList[i].call(this);
            }
        }
    }
    private _setTracksFinished() {
        const tracks = this._tracks;
        const tracksKeys = this._trackKeys;
        for (let i = 0; i < tracksKeys.length; i++) {
            tracks[tracksKeys[i]].setFinished();
        }
    }

    private _getAdditiveTrack(trackName: string): Track {
        let additiveTrack;
        const additiveAnimators = this._additiveAnimators;
        if (additiveAnimators) {
            for (let i = 0; i < additiveAnimators.length; i++) {
                const track = additiveAnimators[i].getTrack(trackName);
                if (track) {
                    // Use the track of latest animator.
                    additiveTrack = track;
                }
            }
        }
        return additiveTrack;
    }

    /**
     * Start the animation
     * @param easing
     * @param  minDuration Set min duration of animation.
     * @return
     */
    start(
        easing?: AnimationEasing,
        minDuration?: number
    ) {
        if (this._started > 0) {
            return;
        }
        this._started = 1;

        const self = this;

        let tracks: Track[] = [];
        let oneShotTracks: Track[] = [];
        let maxTime = this._maxTime || 0;
        if (minDuration) {
            maxTime = Math.max(minDuration, maxTime);
        }

        for (let i = 0; i < this._trackKeys.length; i++) {
            const propName = this._trackKeys[i];
            const track = this._tracks[propName];
            const additiveTrack = this._getAdditiveTrack(propName);
            const kfs = track.keyframes;
            const kfsNum = kfs.length;
            track.prepare(this._maxTime, additiveTrack);
            if (track.needsAnimate()) {
                tracks.push(track);
            }
            else if (!track.interpolable) {
                const lastKf = kfs[kfsNum - 1];
                // Set final value.
                if (lastKf) {
                    (self._target as any)[track.propName] = lastKf.value;
                }
            }
            else if (kfsNum === 1) {
                oneShotTracks.push(track);
            }
        }
        // Add during callback on the last clip
        if (tracks.length || minDuration > 0) {
            const clip = new Clip({
                life: maxTime,
                loop: this._loop,
                delay: this._delay,
                onframe(percent: number) {
                    self._started = 2;
                    // Remove additived animator if it's finished.
                    // For the purpose of memory effeciency.
                    const additiveAnimators = self._additiveAnimators;
                    if (additiveAnimators) {
                        let stillHasAdditiveAnimator = false;
                        for (let i = 0; i < additiveAnimators.length; i++) {
                            if (additiveAnimators[i]._clip) {
                                stillHasAdditiveAnimator = true;
                                break;
                            }
                        }
                        if (!stillHasAdditiveAnimator) {
                            self._additiveAnimators = null;
                        }
                    }

                    for (let i = 0; i < tracks.length; i++) {
                        // NOTE: don't cache target outside.
                        // Because target may be changed.
                        tracks[i].step(self._target, percent);
                    }
                    if (oneShotTracks) {
                        // For tracks that only has percent: 0 keyframe
                        // We do step once for setting the property to the targets.
                        // For example. animate().when(0, { x: 0 }).when(100, {x: 0})
                        // Only the first keyframe will be keepd.
                        for (let i = 0; i < oneShotTracks.length; i++) {
                            oneShotTracks[i].step(self._target, percent);
                        }
                        oneShotTracks = null;
                    }

                    const onframeList = self._onframeCbs;
                    if (onframeList) {
                        for (let i = 0; i < onframeList.length; i++) {
                            onframeList[i](self._target, percent);
                        }
                    }
                },
                ondestroy() {
                    self._doneCallback();
                }
            });
            this._clip = clip;

            if (this.animation) {
                this.animation.addClip(clip);
            }

            if (easing) {
                clip.setEasing(easing);
            }
        }
        else {
            // This optimization will help the case that in the upper application
            // the view may be refreshed frequently, where animation will be
            // called repeatly but nothing changed.
            this._doneCallback();
        }

        return this;
    }
    /**
     * Stop animation
     * @param {boolean} forwardToLast If move to last frame before stop
     */
    stop(forwardToLast?: boolean) {
        if (!this._clip) {
            return;
        }
        const clip = this._clip;
        if (forwardToLast) {
            // Move to last frame before stop
            clip.onframe(1);
        }

        this._abortedCallback();
    }
    /**
     * Set when animation delay starts
     * @param time 单位ms
     */
    delay(time: number) {
        this._delay = time;
        return this;
    }
    /**
     * 添加动画每一帧的回调函数
     * @param callback
     */
    during(cb: OnframeCallback<T>) {
        if (cb) {
            if (!this._onframeCbs) {
                this._onframeCbs = [];
            }
            this._onframeCbs.push(cb);
        }
        return this;
    }
    /**
     * Add callback for animation end
     * @param cb
     */
    done(cb: DoneCallback) {
        if (cb) {
            if (!this._doneCbs) {
                this._doneCbs = [];
            }
            this._doneCbs.push(cb);
        }
        return this;
    }

    aborted(cb: AbortCallback) {
        if (cb) {
            if (!this._abortedCbs) {
                this._abortedCbs = [];
            }
            this._abortedCbs.push(cb);
        }
        return this;
    }

    getClip() {
        return this._clip;
    }

    getTrack(propName: string) {
        return this._tracks[propName];
    }

    getTracks() {
        return map(this._trackKeys, key => this._tracks[key]);
    }

    /**
     * Return true if animator is not available anymore.
     */
    stopTracks(propNames: string[], forwardToLast?: boolean): boolean {
        if (!propNames.length || !this._clip) {
            return true;
        }
        const tracks = this._tracks;
        const tracksKeys = this._trackKeys;

        for (let i = 0; i < propNames.length; i++) {
            const track = tracks[propNames[i]];
            if (track && !track.isFinished()) {
                if (forwardToLast) {
                    track.step(this._target, 1);
                }
                // If the track has not been run for at least wrong frame.
                // The property may be stayed at the final state. when setToFinal is set true.
                // For example:
                // Animate x from 0 to 100, then animate to 150 immediately.
                // We want the x is translated from 0 to 150, not 100 to 150.
                else if (this._started === 1) {
                    track.step(this._target, 0);
                }
                // Set track to finished
                track.setFinished();
            }
        }
        let allAborted = true;
        for (let i = 0; i < tracksKeys.length; i++) {
            if (!tracks[tracksKeys[i]].isFinished()) {
                allAborted = false;
                break;
            }
        }
        // Remove clip if all tracks has been aborted.
        if (allAborted) {
            this._abortedCallback();
        }

        return allAborted;
    }

    /**
     * Save values of final state to target.
     * It is mainly used in state mangement. When state is switching during animation.
     * We need to save final state of animation to the normal state. Not interpolated value.
     *
     * @param target
     * @param trackKeys
     * @param firstOrLast If save first frame or last frame
     */
    saveTo(
        target: T,
        trackKeys?: readonly string[],
        firstOrLast?: boolean
    ) {
        if (!target) {  // DO nothing if target is not given.
            return;
        }

        trackKeys = trackKeys || this._trackKeys;

        for (let i = 0; i < trackKeys.length; i++) {
            const propName = trackKeys[i];
            const track = this._tracks[propName];
            if (!track || track.isFinished()) {   // Ignore finished track.
                continue;
            }
            const kfs = track.keyframes;
            const kf = kfs[firstOrLast ? 0 : kfs.length - 1];
            if (kf) {
                // TODO CLONE?
                let val: unknown = cloneValue(kf.value as any);
                if (track.isColor) {
                    val = rgba2String(val as number[]);
                }

                (target as any)[propName] = val;
            }
        }
    }

    // Change final value after animator has been started.
    // NOTE: Be careful to use it.
    __changeFinalValue(finalProps: Dictionary<any>, trackKeys?: readonly string[]) {
        trackKeys = trackKeys || keys(finalProps);

        for (let i = 0; i < trackKeys.length; i++) {
            const propName = trackKeys[i];

            const track = this._tracks[propName];
            if (!track) {
                continue;
            }

            const kfs = track.keyframes;
            if (kfs.length > 1) {
                // Remove the original last kf and add again.
                const lastKf = kfs.pop();

                track.addKeyframe(lastKf.time, finalProps[propName]);
                // Prepare again.
                track.prepare(this._maxTime, track.getAdditiveTrack());
            }
        }
    }
}

export type AnimatorTrack = Track;