// Copyright 2014 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as i18n from '../../core/i18n/i18n.js';
import * as SDK from '../../core/sdk/sdk.js';
import type * as Protocol from '../../generated/protocol.js';
import * as TraceEngine from '../trace/trace.js';

import {RecordType, TimelineModelImpl} from './TimelineModel.js';

const UIStrings = {
  /**
   *@description Text for the name of a thread of the page
   *@example {1} PH1
   */
  threadS: 'Thread {PH1}',
};
const str_ = i18n.i18n.registerUIStrings('models/timeline_model/TimelineJSProfile.ts', UIStrings);
const i18nString = i18n.i18n.getLocalizedString.bind(undefined, str_);
export class TimelineJSProfileProcessor {
  static generateConstructedEventsFromCpuProfileDataModel(
      jsProfileModel: SDK.CPUProfileDataModel.CPUProfileDataModel,
      thread: SDK.TracingModel.Thread): SDK.TracingModel.Event[] {
    const samples = jsProfileModel.samples || [];
    const timestamps = jsProfileModel.timestamps;
    const jsEvents = [];
    const nodeToStackMap = new Map<SDK.ProfileTreeModel.ProfileNode|null, Protocol.Runtime.CallFrame[]>();

    let prevNode: SDK.ProfileTreeModel.ProfileNode = jsProfileModel.root;
    let prevCallFrames: Protocol.Runtime.CallFrame[] = [];
    for (let i = 0; i < samples.length; ++i) {
      const node: SDK.ProfileTreeModel.ProfileNode|null = jsProfileModel.nodeByIndex(i);
      if (!node) {
        console.error(`Node with unknown id ${samples[i]} at index ${i}`);
        continue;
      }
      let callFrames;
      if (node === jsProfileModel.gcNode) {
        if (prevNode === jsProfileModel.gcNode) {
          // If the last recorded sample is also GC sample, we just use the same call frames.
          callFrames = prevCallFrames;
        } else {
          // GC samples have no stack, so we just put GC node on top of the last recorded sample.
          callFrames = [(node as Protocol.Runtime.CallFrame), ...prevCallFrames];
        }
      } else {
        // For non Garbage Collection nodes, we just use its own call frames.
        callFrames = nodeToStackMap.get(node);
        if (!callFrames) {
          callFrames = new Array(node.depth + 1) as Protocol.Runtime.CallFrame[];
          nodeToStackMap.set(node, callFrames);
          let currentNode = node;
          for (let j = 0; currentNode.parent; currentNode = currentNode.parent) {
            callFrames[j++] = (currentNode as Protocol.Runtime.CallFrame);
          }
        }
      }

      const name = node === jsProfileModel.idleNode                             ? RecordType.JSIdleSample :
          node === jsProfileModel.programNode || node === jsProfileModel.gcNode ? RecordType.JSSystemSample :
                                                                                  RecordType.JSSample;

      const jsSampleEvent = new SDK.TracingModel.ConstructedEvent(
          SDK.TracingModel.DevToolsTimelineEventCategory, name, TraceEngine.Types.TraceEvents.Phase.INSTANT,
          timestamps[i], thread);
      jsSampleEvent.args['data'] = {stackTrace: callFrames};
      jsEvents.push(jsSampleEvent);

      prevNode = node;
      prevCallFrames = callFrames;
    }
    return jsEvents;
  }

  static generateJSFrameEvents(events: SDK.TracingModel.Event[], config: {
    showAllEvents: boolean,
    showRuntimeCallStats: boolean,
    showNativeFunctions: boolean,
  }): SDK.TracingModel.Event[] {
    function equalFrames(frame1: Protocol.Runtime.CallFrame, frame2: Protocol.Runtime.CallFrame): boolean {
      return frame1.scriptId === frame2.scriptId && frame1.functionName === frame2.functionName &&
          frame1.lineNumber === frame2.lineNumber;
    }

    function isJSInvocationEvent(e: SDK.TracingModel.Event): boolean {
      switch (e.name) {
        case RecordType.RunMicrotasks:
        case RecordType.FunctionCall:
        case RecordType.EvaluateScript:
        case RecordType.EvaluateModule:
        case RecordType.EventDispatch:
        case RecordType.V8Execute:
          return true;
      }
      // Also consider any new v8 trace events. (eg 'V8.RunMicrotasks' and 'v8.run')
      if (e.name.startsWith('v8') || e.name.startsWith('V8')) {
        return true;
      }
      return false;
    }

    const jsFrameEvents: SDK.TracingModel.Event[] = [];
    const jsFramesStack: SDK.TracingModel.Event[] = [];
    const lockedJsStackDepth: number[] = [];
    let ordinal = 0;
    /**
     * `isJSInvocationEvent()` relies on an allowlist of invocation events that will parent JSFrames.
     * However in some situations (workers), we don't have those trace events.
     * "fake" JSInvocations are created when we have active JSSamples but seemingly no explicit invocation.
     */
    let fakeJSInvocation = false;
    const {showAllEvents, showRuntimeCallStats, showNativeFunctions} = config;

    /**
     * JSSamples are instant events, so any start events are not the samples.
     * We expect they'll either be trace events happening within JS (eg forced layout),
     * or, in the fakeJSInvocation case, the JS finished and we're seeing the subsequent event.
     */
    function onStartEvent(e: SDK.TracingModel.CompatibleTraceEvent): void {
      if (SDK.TracingModel.eventIsFromNewEngine(e)) {
        // TODO(crbug.com/1431175) support CPU profiles in new engine.
        return;
      }
      if (fakeJSInvocation) {
        truncateJSStack((lockedJsStackDepth.pop() as number), e.startTime);
        fakeJSInvocation = false;
      }
      e.ordinal = ++ordinal;
      extractStackTrace(e);
      // For the duration of the event we cannot go beyond the stack associated with it.
      lockedJsStackDepth.push(jsFramesStack.length);
    }

    function onInstantEvent(
        e: SDK.TracingModel.CompatibleTraceEvent, parent: SDK.TracingModel.CompatibleTraceEvent|null): void {
      if (SDK.TracingModel.eventIsFromNewEngine(e) || SDK.TracingModel.eventIsFromNewEngine(parent)) {
        // TODO(crbug.com/1431175) support CPU profiles in new engine.
        return;
      }
      e.ordinal = ++ordinal;
      if ((parent && isJSInvocationEvent(parent)) || fakeJSInvocation) {
        extractStackTrace(e);
      } else if (
          (e.name === RecordType.JSSample || e.name === RecordType.JSSystemSample ||
           e.name === RecordType.JSIdleSample) &&
          e.args?.data?.stackTrace?.length && jsFramesStack.length === 0) {
        // Force JS Samples to show up even if we are not inside a JS invocation event, because we
        // can be missing the start of JS invocation events if we start tracing half-way through.
        // Pretend we have a top-level JS invocation event.
        fakeJSInvocation = true;
        const stackDepthBefore = jsFramesStack.length;
        extractStackTrace(e);
        lockedJsStackDepth.push(stackDepthBefore);
      }
    }

    function onEndEvent(e: SDK.TracingModel.CompatibleTraceEvent): void {
      if (SDK.TracingModel.eventIsFromNewEngine(e)) {
        // TODO(crbug.com/1431175) support CPU profiles in new engine.
        return;
      }
      truncateJSStack((lockedJsStackDepth.pop() as number), (e.endTime as number));
    }

    /**
     * Set an explicit endTime for all active JSFrames.
     * Basically, terminate them by defining their right edge.
     */
    function truncateJSStack(depth: number, time: number): void {
      if (lockedJsStackDepth.length) {
        const lockedDepth = (lockedJsStackDepth[lockedJsStackDepth.length - 1] as number);
        if (depth < lockedDepth) {
          console.error(`Child stack is shallower (${depth}) than the parent stack (${lockedDepth}) at ${time}`);
          depth = lockedDepth;
        }
      }
      if (jsFramesStack.length < depth) {
        console.error(`Trying to truncate higher than the current stack size at ${time}`);
        depth = jsFramesStack.length;
      }
      for (let k = 0; k < jsFramesStack.length; ++k) {
        jsFramesStack[k].setEndTime(time);
      }
      jsFramesStack.length = depth;
    }

    function showNativeName(name: string): boolean {
      return showRuntimeCallStats && Boolean(TimelineJSProfileProcessor.nativeGroup(name));
    }

    function filterStackFrames(stack: Protocol.Runtime.CallFrame[]): void {
      if (showAllEvents) {
        return;
      }
      let previousNativeFrameName: (string|null)|null = null;
      let j = 0;
      for (let i = 0; i < stack.length; ++i) {
        const frame = stack[i];
        const url = frame.url;
        const isNativeFrame = url && url.startsWith('native ');
        if (!showNativeFunctions && isNativeFrame) {
          continue;
        }
        const isNativeRuntimeFrame = TimelineJSProfileProcessor.isNativeRuntimeFrame(frame);
        if (isNativeRuntimeFrame && !showNativeName(frame.functionName)) {
          continue;
        }
        const nativeFrameName =
            isNativeRuntimeFrame ? TimelineJSProfileProcessor.nativeGroup(frame.functionName) : null;
        if (previousNativeFrameName && previousNativeFrameName === nativeFrameName) {
          continue;
        }
        previousNativeFrameName = nativeFrameName;
        stack[j++] = frame;
      }
      stack.length = j;
    }

    function extractStackTrace(e: SDK.TracingModel.Event): void {
      const callFrames: Protocol.Runtime.CallFrame[] =
          (e.name === RecordType.JSSample || e.name === RecordType.JSSystemSample ||
           e.name === RecordType.JSIdleSample) ?
          e.args['data']['stackTrace'].slice().reverse() :
          jsFramesStack.map(frameEvent => frameEvent.args['data']);
      filterStackFrames(callFrames);
      const endTime = e.endTime || e.startTime;
      const minFrames = Math.min(callFrames.length, jsFramesStack.length);
      let i;
      for (i = lockedJsStackDepth[lockedJsStackDepth.length - 1] || 0; i < minFrames; ++i) {
        const newFrame = callFrames[i];
        const oldFrame = jsFramesStack[i].args['data'];
        if (!equalFrames(newFrame, oldFrame)) {
          break;
        }
        // Scoot the right edge of this callFrame to the right
        jsFramesStack[i].setEndTime(Math.max((jsFramesStack[i].endTime as number), endTime));
      }
      truncateJSStack(i, e.startTime);
      for (; i < callFrames.length; ++i) {
        const frame = callFrames[i];
        let jsFrameType = RecordType.JSFrame;
        switch (e.name) {
          case RecordType.JSIdleSample:
            jsFrameType = RecordType.JSIdleFrame;
            break;
          case RecordType.JSSystemSample:
            jsFrameType = RecordType.JSSystemFrame;
            break;
        }
        const jsFrameEvent = new SDK.TracingModel.ConstructedEvent(
            SDK.TracingModel.DevToolsTimelineEventCategory, jsFrameType, TraceEngine.Types.TraceEvents.Phase.COMPLETE,
            e.startTime, e.thread);
        jsFrameEvent.ordinal = e.ordinal;
        jsFrameEvent.addArgs({data: frame});
        jsFrameEvent.setEndTime(endTime);
        jsFramesStack.push(jsFrameEvent);
        jsFrameEvents.push(jsFrameEvent);
      }
    }

    const firstTopLevelEvent = events.find(SDK.TracingModel.TracingModel.isTopLevelEvent);
    const startTime = firstTopLevelEvent ? firstTopLevelEvent.startTime : 0;
    TimelineModelImpl.forEachEvent(events, onStartEvent, onEndEvent, onInstantEvent, startTime);
    return jsFrameEvents;
  }

  static isNativeRuntimeFrame(frame: Protocol.Runtime.CallFrame): boolean {
    return frame.url === 'native V8Runtime';
  }

  static nativeGroup(nativeName: string): string|null {
    if (nativeName.startsWith('Parse')) {
      return TimelineJSProfileProcessor.NativeGroups.Parse;
    }
    if (nativeName.startsWith('Compile') || nativeName.startsWith('Recompile')) {
      return TimelineJSProfileProcessor.NativeGroups.Compile;
    }
    return null;
  }

  static createFakeTraceFromCpuProfile(profile: any, tid: number, injectPageEvent: boolean, name?: string|null):
      SDK.TracingManager.EventPayload[] {
    const events: SDK.TracingManager.EventPayload[] = [];

    if (injectPageEvent) {
      appendEvent('TracingStartedInPage', {data: {'sessionId': '1'}}, 0, 0, 'M');
    }
    if (!name) {
      name = i18nString(UIStrings.threadS, {PH1: tid});
    }
    appendEvent(SDK.TracingModel.MetadataEvent.ThreadName, {name}, 0, 0, 'M', '__metadata');
    if (!profile) {
      return events;
    }

    // Append a root to show the start time of the profile (which is earlier than first sample), so the Performance
    // panel won't truncate this time period.
    appendEvent(RecordType.JSRoot, {}, profile.startTime, profile.endTime - profile.startTime, 'X', 'toplevel');
    // TODO: create a `Profile` event instead, as `cpuProfile` is legacy
    appendEvent('CpuProfile', {data: {'cpuProfile': profile}}, profile.endTime, 0, 'I');
    return events;

    function appendEvent(
        name: string, args: any, ts: number, dur?: number, ph?: string, cat?: string): SDK.TracingManager.EventPayload {
      const event =
          ({cat: cat || 'disabled-by-default-devtools.timeline', name, ph: ph || 'X', pid: 1, tid, ts, args} as
           SDK.TracingManager.EventPayload);
      if (dur) {
        event.dur = dur;
      }
      events.push(event);
      return event;
    }
  }
}

export namespace TimelineJSProfileProcessor {
  // TODO(crbug.com/1172300) Ignored during the jsdoc to ts migration)
  // eslint-disable-next-line rulesdir/const_enum
  export enum NativeGroups {
    Compile = 'Compile',
    Parse = 'Parse',
  }
}
