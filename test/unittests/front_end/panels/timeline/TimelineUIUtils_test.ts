// Copyright 2021 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as SDK from '../../../../../front_end/core/sdk/sdk.js';
import * as TimelineModel from '../../../../../front_end/models/timeline_model/timeline_model.js';
import type * as Platform from '../../../../../front_end/core/platform/platform.js';
import * as Components from '../../../../../front_end/ui/legacy/components/utils/utils.js';
import * as TraceEngine from '../../../../../front_end/models/trace/trace.js';
import * as Timeline from '../../../../../front_end/panels/timeline/timeline.js';
import {createTarget} from '../../helpers/EnvironmentHelpers.js';
import {describeWithMockConnection} from '../../helpers/MockConnection.js';
import {FakeStorage} from '../../helpers/TimelineHelpers.js';
import * as Workspace from '../../../../../front_end/models/workspace/workspace.js';
import * as Bindings from '../../../../../front_end/models/bindings/bindings.js';
import {setupPageResourceLoaderForSourceMap} from '../../helpers/SourceMapHelpers.js';
import type * as Protocol from '../../../../../front_end/generated/protocol.js';
import {allModelsFromFile, getAllTracingModelPayloadEvents} from '../../helpers/TraceHelpers.js';
import * as Common from '../../../../../front_end/core/common/common.js';

const {assert} = chai;

describeWithMockConnection('TimelineUIUtils', () => {
  let tracingModel: SDK.TracingModel.TracingModel;
  let process: SDK.TracingModel.Process;
  let thread: SDK.TracingModel.Thread;
  let target: SDK.Target.Target;
  const SCRIPT_ID = 'SCRIPT_ID' as Protocol.Runtime.ScriptId;

  beforeEach(() => {
    target = createTarget();
    tracingModel = new SDK.TracingModel.TracingModel(new FakeStorage());
    process = new SDK.TracingModel.Process(tracingModel, 1);
    thread = new SDK.TracingModel.Thread(process, 1);

    const workspace = Workspace.Workspace.WorkspaceImpl.instance();
    const targetManager = SDK.TargetManager.TargetManager.instance();
    const resourceMapping = new Bindings.ResourceMapping.ResourceMapping(targetManager, workspace);
    const debuggerWorkspaceBinding = Bindings.DebuggerWorkspaceBinding.DebuggerWorkspaceBinding.instance({
      forceNew: true,
      resourceMapping,
      targetManager,
    });
    Bindings.IgnoreListManager.IgnoreListManager.instance({forceNew: true, debuggerWorkspaceBinding});
  });

  it('creates top frame location text for function calls', async () => {
    const event = new SDK.TracingModel.ConstructedEvent(
        'devtools.timeline', 'FunctionCall', TraceEngine.Types.TraceEvents.Phase.COMPLETE, 10, thread);

    event.addArgs({
      data: {
        functionName: 'test',
        url: 'test.js',
        scriptId: SCRIPT_ID,
        lineNumber: 0,
        columnNumber: 0,
      },
    });
    assert.strictEqual(
        'test.js:1:1', await Timeline.TimelineUIUtils.TimelineUIUtils.buildDetailsTextForTraceEvent(event));
  });

  it('creates top frame location text as a fallback', async () => {
    // 'TimerInstall' is chosen such that we run into the 'default' case.
    const event = new SDK.TracingModel.ConstructedEvent(
        'devtools.timeline', 'TimerInstall', TraceEngine.Types.TraceEvents.Phase.COMPLETE, 10, thread);

    event.addArgs({
      data: {
        stackTrace: [
          {
            functionName: 'test',
            url: 'test.js',
            scriptId: SCRIPT_ID,
            lineNumber: 0,
            columnNumber: 0,
          },
        ],
      },
    });
    const data = TimelineModel.TimelineModel.EventOnTimelineData.forEvent(event);
    data.stackTrace = event.args.data.stackTrace;
    assert.strictEqual(
        'test.js:1:1', await Timeline.TimelineUIUtils.TimelineUIUtils.buildDetailsTextForTraceEvent(event));
  });

  describe('script location as an URL', () => {
    let event: SDK.TracingModel.ConstructedEvent;
    beforeEach(() => {
      event = new SDK.TracingModel.ConstructedEvent(
          'devtools.timeline', TimelineModel.TimelineModel.RecordType.FunctionCall,
          TraceEngine.Types.TraceEvents.Phase.COMPLETE, 10, thread);

      event.addArgs({
        data: {
          functionName: 'test',
          url: 'https://google.com/test.js',
          scriptId: SCRIPT_ID,
          lineNumber: 0,
          columnNumber: 0,
        },
      });
    });
    it('makes the script location of a call frame a full URL when the inspected target is not the same the call frame was taken from (e.g. a loaded file)',
       async () => {
         target.setInspectedURL('https://not-google.com' as Platform.DevToolsPath.UrlString);
         const node = await Timeline.TimelineUIUtils.TimelineUIUtils.buildDetailsNodeForTraceEvent(
             event, target, new Components.Linkifier.Linkifier());
         if (!node) {
           throw new Error('Node was unexpectedly null');
         }
         assert.strictEqual(node.textContent, 'test @ google.com/test.js:1:1');
       });

    it('makes the script location of a call frame a script name when the inspected target is the one the call frame was taken from',
       async () => {
         target.setInspectedURL('https://google.com' as Platform.DevToolsPath.UrlString);
         const node = await Timeline.TimelineUIUtils.TimelineUIUtils.buildDetailsNodeForTraceEvent(
             event, target, new Components.Linkifier.Linkifier());
         if (!node) {
           throw new Error('Node was unexpectedly null');
         }
         assert.strictEqual(node.textContent, 'test @ /test.js:1:1');
       });
  });

  describe('mapping to autored script when recording is fresh', () => {
    beforeEach(async () => {
      // Register mock script and source map.

      const sourceMapContent = JSON.stringify({
        'version': 3,
        'names': ['unminified', 'par1', 'par2', 'console', 'log'],
        'sources': [
          '/original-script.ts',
        ],
        'file': '/test.js',
        'sourcesContent': ['function unminified(par1, par2) {\n  console.log(par1, par2);\n}\n'],
        'mappings': 'AAAA,SAASA,EAAWC,EAAMC,GACxBC,QAAQC,IAAIH,EAAMC',
      });
      setupPageResourceLoaderForSourceMap(sourceMapContent);
      target.setInspectedURL('https://google.com' as Platform.DevToolsPath.UrlString);
      const scriptUrl = 'https://google.com/script.js' as Platform.DevToolsPath.UrlString;
      const sourceMapUrl = 'script.js.map' as Platform.DevToolsPath.UrlString;
      const debuggerModel = target.model(SDK.DebuggerModel.DebuggerModel);
      assert.isNotNull(debuggerModel);
      if (debuggerModel === null) {
        return;
      }
      const sourceMapManager = debuggerModel.sourceMapManager();
      const script = debuggerModel.parsedScriptSource(
          SCRIPT_ID, scriptUrl, 0, 0, 0, 0, 0, '', undefined, false, sourceMapUrl, true, false, length, false, null,
          null, null, null, null);
      await sourceMapManager.sourceMapForClientPromise(script);
    });
    it('maps to the authored script when a call frame is provided', async () => {
      const linkifier = new Components.Linkifier.Linkifier();
      let linkifierCallback: () => void = () => {};
      const likifiedPromise = new Promise<void>(res => {
        linkifierCallback = res;
      });
      linkifier.setLiveLocationUpdateCallback(linkifierCallback);
      const node = Timeline.TimelineUIUtils.TimelineUIUtils.linkifyLocation({
        scriptId: SCRIPT_ID,
        url: 'https://google.com/test.js',
        lineNumber: 0,
        columnNumber: 0,
        isFreshRecording: true,
        target,
        linkifier,
      });
      if (!node) {
        throw new Error('Node was unexpectedly null');
      }
      // Wait for the location to be resolved using the registered source map.
      await likifiedPromise;

      assert.strictEqual(node.textContent, 'original-script.ts:1:1');
    });
    it('maps to the authored script when a trace event with a stack trace is provided', async () => {
      const functionCallEvent = new SDK.TracingModel.ConstructedEvent(
          'devtools.timeline', TimelineModel.TimelineModel.RecordType.FunctionCall,
          TraceEngine.Types.TraceEvents.Phase.COMPLETE, 10, thread);
      functionCallEvent.addArgs({
        data: {
          stackTrace: [{
            functionName: 'test',
            url: 'https://google.com/test.js',
            scriptId: SCRIPT_ID,
            lineNumber: 0,
            columnNumber: 0,
          }],
        },
      });
      const data = TimelineModel.TimelineModel.EventOnTimelineData.forEvent(functionCallEvent);
      data.stackTrace = functionCallEvent.args.data.stackTrace;
      const linkifier = new Components.Linkifier.Linkifier();
      let linkifierCallback: () => void = () => {};
      const likifiedPromise = new Promise<void>(res => {
        linkifierCallback = res;
      });
      linkifier.setLiveLocationUpdateCallback(linkifierCallback);
      const node =
          Timeline.TimelineUIUtils.TimelineUIUtils.linkifyTopCallFrame(functionCallEvent, target, linkifier, true);
      if (!node) {
        throw new Error('Node was unexpectedly null');
      }
      // Wait for the location to be resolved using the registered source map.
      await likifiedPromise;
      assert.strictEqual(node.textContent, 'original-script.ts:1:1');
    });
  });
  describe('adjusting timestamps for events and navigations', () => {
    it('adjusts the time for a DCL event after a navigation', async () => {
      const data = await allModelsFromFile('web-dev.json.gz');
      const allSDKEvents = getAllTracingModelPayloadEvents(data.tracingModel);
      const mainFrameID = data.timelineModel.mainFrameID();
      const dclSDKEvent = allSDKEvents.find(event => {
        return event.name === TimelineModel.TimelineModel.RecordType.MarkDOMContent &&
            mainFrameID === event.args.data.frame;
      });
      if (!dclSDKEvent) {
        throw new Error('Could not find DCL event');
      }

      // Round the time to 2DP to avoid needlessly long expectation numbers!
      const unAdjustedTime = (dclSDKEvent.startTime - data.timelineModel.minimumRecordTime()).toFixed(2);
      assert.strictEqual(unAdjustedTime, String(190.79));

      const adjustedTime = Timeline.TimelineUIUtils.timeStampForEventAdjustedForClosestNavigationIfPossible(
          dclSDKEvent.rawPayload(), data.timelineModel, data.traceParsedData);
      assert.strictEqual(adjustedTime.toFixed(2), String(178.92));
    });

    it('falls back to the legacy model if the new data is not available', async () => {
      const data = await allModelsFromFile('web-dev.json.gz');
      const allSDKEvents = getAllTracingModelPayloadEvents(data.tracingModel);
      const lcpSDKEvent = allSDKEvents.find(event => {
        // Can use find here as this trace file only has one LCP Candidate
        return event.name === TimelineModel.TimelineModel.RecordType.MarkLCPCandidate && event.args.data.isMainFrame;
      });
      if (!lcpSDKEvent) {
        throw new Error('Could not find LCP event');
      }

      const adjustedLCPTime = Timeline.TimelineUIUtils.timeStampForEventAdjustedForClosestNavigationIfPossible(
          lcpSDKEvent,
          data.timelineModel,
          // Fake the new engine not being available by passing in null here.
          null,
      );
      assert.strictEqual(adjustedLCPTime.toFixed(2), String(118.44));
    });

    it('can adjust the times for events that are not PageLoad markers', async () => {
      const data = await allModelsFromFile('user-timings.json.gz');
      const allSDKEvents = getAllTracingModelPayloadEvents(data.tracingModel);
      // Use a performance.mark event. Exact event is unimportant except that
      // it should not be a Page Load event as those are covered by the tests
      // above.
      const userMark = allSDKEvents.find(event => {
        return event.hasCategory('blink.user_timing') && event.name === 'mark1';
      });
      if (!userMark) {
        throw new Error('Could not find user mark');
      }

      const adjustedMarkTime = Timeline.TimelineUIUtils.timeStampForEventAdjustedForClosestNavigationIfPossible(
          userMark, data.timelineModel, data.traceParsedData);
      assert.strictEqual(adjustedMarkTime.toFixed(2), String(79.88));
    });
  });

  function getRowDataForDetailsElement(details: DocumentFragment) {
    return Array.from(details.querySelectorAll<HTMLDivElement>('.timeline-details-view-row')).map(row => {
      const title = row.querySelector<HTMLDivElement>('.timeline-details-view-row-title')?.innerText;
      const value = row.querySelector<HTMLDivElement>('.timeline-details-view-row-value')?.innerText;
      return {title, value};
    });
  }

  describe('traceEventDetails', () => {
    it('shows the interaction ID for EventTiming events that have an interaction ID', async () => {
      const data = await allModelsFromFile('slow-interaction-button-click.json.gz');
      const interactionEvent = data.traceParsedData.UserInteractions.interactionEventsWithNoNesting[0];
      const details = await Timeline.TimelineUIUtils.TimelineUIUtils.buildTraceEventDetails(
          interactionEvent,
          data.timelineModel,
          new Components.Linkifier.Linkifier(),
          false,
          data.traceParsedData,
      );
      const rowData = getRowDataForDetailsElement(details);
      assert.deepEqual(rowData, [{
                         title: 'ID',
                         value: '1540',
                       }]);
    });

    it('renders the details for a layout shift properly', async () => {
      Common.Linkifier.registerLinkifier({
        contextTypes() {
          return [Timeline.CLSLinkifier.CLSRect];
        },
        async loadLinkifier() {
          return Timeline.CLSLinkifier.Linkifier.instance();
        },
      });

      const data = await allModelsFromFile('cls-single-frame.json.gz');
      const layoutShift = data.traceParsedData.LayoutShifts.clusters[0].events[0];
      if (!layoutShift) {
        throw new Error('Could not find LayoutShift event.');
      }

      const details = await Timeline.TimelineUIUtils.TimelineUIUtils.buildTraceEventDetails(
          layoutShift,
          data.timelineModel,
          new Components.Linkifier.Linkifier(),
          false,
          data.traceParsedData,
      );
      const rowData = getRowDataForDetailsElement(details);
      assert.deepEqual(
          rowData,
          [
            {
              title: 'Warning',
              value: 'Cumulative Layout Shifts can result in poor user experiences. It has recently evolved.',
            },
            {title: 'Score', value: '0.04218'},
            {title: 'Cumulative Score', value: '0.04218'},
            {title: 'Current Cluster ID', value: '1'},
            {title: 'Current Cluster Score', value: '0.2952'},
            {title: 'Had recent input', value: 'No'},
            {title: 'Moved from', value: 'Location: [120,670], Size: [900x900]'},
            {title: 'Moved to', value: 'Location: [120,1270], Size: [900x478]'},
          ],
      );
    });
  });

  describe('buildNetworkRequestDetails', () => {
    it('renders the right details for a network event', async () => {
      const data = await allModelsFromFile('lcp-web-font.json.gz');
      const networkRequests = data.timelineModel.networkRequests();
      const cssRequest = networkRequests.find(request => {
        return request.url === 'http://localhost:3000/app.css';
      });
      if (!cssRequest) {
        throw new Error('Could not find expected network request.');
      }

      const details = await Timeline.TimelineUIUtils.TimelineUIUtils.buildNetworkRequestDetails(
          cssRequest,
          data.timelineModel,
          new Components.Linkifier.Linkifier(),
      );

      const rowData = getRowDataForDetailsElement(details);
      assert.deepEqual(
          rowData,
          [
            {title: 'URL', value: 'localhost:3000/app.css'},
            {title: 'Duration', value: '4.07 ms (3.08 ms network transfer + 1.00 ms resource loading)'},
            {title: 'Request Method', value: 'GET'},
            {title: 'Priority', value: 'Highest'},
            {title: 'Mime Type', value: 'text/css'},
            {title: 'Encoded Data', value: '402 B'},
            {title: 'Decoded Body', value: '96 B'},
          ],
      );
    });
  });

  describe('eventTitle', () => {
    it('renders the correct title for an EventTiming interaction event', async () => {
      const data = await allModelsFromFile('slow-interaction-button-click.json.gz');
      const interactionEvent = data.traceParsedData.UserInteractions.interactionEventsWithNoNesting[0];
      const details = Timeline.TimelineUIUtils.TimelineUIUtils.eventTitle(interactionEvent);
      assert.deepEqual(details, 'Pointer');
    });
  });
});
