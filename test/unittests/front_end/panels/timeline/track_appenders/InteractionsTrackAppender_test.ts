// Copyright 2023 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as TraceEngine from '../../../../../../front_end/models/trace/trace.js';
import * as Timeline from '../../../../../../front_end/panels/timeline/timeline.js';
import * as PerfUI from '../../../../../../front_end/ui/legacy/components/perf_ui/perf_ui.js';
import {describeWithEnvironment} from '../../../helpers/EnvironmentHelpers.js';
import {traceModelFromTraceFile} from '../../../helpers/TimelineHelpers.js';
import {loadModelDataFromTraceFile} from '../../../helpers/TraceHelpers.js';

import type * as TimelineModel from '../../../../../../front_end/models/timeline_model/timeline_model.js';

const {assert} = chai;

function initTrackAppender(
    flameChartData: PerfUI.FlameChart.FlameChartTimelineData,
    traceParsedData: TraceEngine.Handlers.Types.TraceParseData,
    entryData: Timeline.TimelineFlameChartDataProvider.TimelineFlameChartEntry[],
    entryTypeByLevel: Timeline.TimelineFlameChartDataProvider.EntryType[],
    timelineModel: TimelineModel.TimelineModel.TimelineModelImpl):
    Timeline.InteractionsTrackAppender.InteractionsTrackAppender {
  const compatibilityTracksAppender = new Timeline.CompatibilityTracksAppender.CompatibilityTracksAppender(
      flameChartData, traceParsedData, entryData, entryTypeByLevel, timelineModel);
  return compatibilityTracksAppender.interactionsTrackAppender();
}

describeWithEnvironment('InteractionsTrackAppender', () => {
  async function renderTrackAppender(trace: string): Promise<{
    entryTypeByLevel: Timeline.TimelineFlameChartDataProvider.EntryType[],
    flameChartData: PerfUI.FlameChart.FlameChartTimelineData,
    interactionsTrackAppender: Timeline.InteractionsTrackAppender.InteractionsTrackAppender,
    entryData: Timeline.TimelineFlameChartDataProvider.TimelineFlameChartEntry[],
    traceParsedData: Readonly<TraceEngine.TraceModel.PartialTraceParseDataDuringMigration>,
  }> {
    const entryTypeByLevel: Timeline.TimelineFlameChartDataProvider.EntryType[] = [];
    const entryData: Timeline.TimelineFlameChartDataProvider.TimelineFlameChartEntry[] = [];
    const flameChartData = PerfUI.FlameChart.FlameChartTimelineData.createEmpty();
    const traceParsedData = await loadModelDataFromTraceFile(trace);
    const timelineModel = (await traceModelFromTraceFile(trace)).timelineModel;
    const interactionsTrackAppender =
        initTrackAppender(flameChartData, traceParsedData, entryData, entryTypeByLevel, timelineModel);
    interactionsTrackAppender.appendTrackAtLevel(0);

    return {
      entryTypeByLevel,
      traceParsedData,
      flameChartData,
      interactionsTrackAppender,
      entryData,
    };
  }

  describe('appendTrackAtLevel', () => {
    it('marks all levels used by the track with the `TrackAppender` type', async () => {
      const {entryTypeByLevel} = await renderTrackAppender('slow-interaction-button-click.json.gz');
      // All events fit on the top level
      assert.strictEqual(entryTypeByLevel.length, 1);
      assert.deepEqual(entryTypeByLevel, [
        Timeline.TimelineFlameChartDataProvider.EntryType.TrackAppender,
      ]);
    });

    it('takes over no levels if there are no interactions', async () => {
      // animation trace has no interactions in it.
      const {entryTypeByLevel} = await renderTrackAppender('animation.json.gz');
      assert.strictEqual(entryTypeByLevel.length, 0);
    });

    it('only shows the top level interactions', async () => {
      const {entryData, traceParsedData} = await renderTrackAppender('nested-interactions.json.gz');
      assert.strictEqual(entryData.length, traceParsedData.UserInteractions.interactionEventsWithNoNesting.length);
    });

    it('creates a flamechart group', async () => {
      const {flameChartData} = await renderTrackAppender('slow-interaction-button-click.json.gz');
      assert.strictEqual(flameChartData.groups.length, 1);
      assert.strictEqual(flameChartData.groups[0].name, 'Interactions');
    });

    it('adds all interactions with the correct start times', async () => {
      const {flameChartData, traceParsedData, entryData} =
          await renderTrackAppender('slow-interaction-button-click.json.gz');
      const events = traceParsedData.UserInteractions.interactionEventsWithNoNesting;
      for (const event of events) {
        const markerIndex = entryData.indexOf(event);
        assert.isDefined(markerIndex);
        assert.strictEqual(
            flameChartData.entryStartTimes[markerIndex],
            TraceEngine.Helpers.Timing.microSecondsToMilliseconds(event.ts));
      }
    });

    it('adds total times correctly', async () => {
      const {flameChartData, traceParsedData, entryData} =
          await renderTrackAppender('slow-interaction-button-click.json.gz');
      const events = traceParsedData.UserInteractions.interactionEventsWithNoNesting;
      for (const event of events) {
        const markerIndex = entryData.indexOf(event);
        assert.isDefined(markerIndex);
        const expectedTotalTimeForEvent = TraceEngine.Helpers.Timing.microSecondsToMilliseconds(
            (event.dur || 0) as TraceEngine.Types.Timing.MicroSeconds);
        assert.strictEqual(flameChartData.entryTotalTimes[markerIndex], expectedTotalTimeForEvent);
      }
    });
  });

  it('candy-stripes long interactions', async () => {
    const {traceParsedData, flameChartData, entryData} = await renderTrackAppender('one-second-interaction.json.gz');
    const longInteraction = traceParsedData.UserInteractions.longestInteractionEvent;
    if (!longInteraction) {
      throw new Error('Could not find longest interaction');
    }
    const entryIndex = entryData.indexOf(longInteraction);
    const decorationsForEntry = flameChartData.entryDecorations[entryIndex];
    assert.deepEqual(
        decorationsForEntry, [{type: 'CANDY', startAtTime: TraceEngine.Types.Timing.MicroSeconds(200_000)}]);
  });

  it('does not candy-stripe interactions less than 200ms', async () => {
    const {flameChartData} = await renderTrackAppender('slow-interaction-button-click.json.gz');
    // None of the interactions are over 200ms, so we do not expect to see any decorations
    assert.lengthOf(flameChartData.entryDecorations, 0);
  });

  it('returns the correct title for a pointer interaction, using its category', async () => {
    const {interactionsTrackAppender, traceParsedData} =
        await renderTrackAppender('slow-interaction-button-click.json.gz');
    const firstInteraction = traceParsedData.UserInteractions.interactionEvents[0];
    const title = interactionsTrackAppender.titleForEvent(firstInteraction);
    assert.strictEqual(title, 'Pointer');
  });

  it('returns the correct title for a keyboard interaction, using its category', async () => {
    const {interactionsTrackAppender, traceParsedData} = await renderTrackAppender('slow-interaction-keydown.json.gz');
    const keydownInteraction = traceParsedData.UserInteractions.interactionEvents.find(e => e.type === 'keydown');
    if (!keydownInteraction) {
      throw new Error('Could not find keydown interaction');
    }
    const title = interactionsTrackAppender.titleForEvent(keydownInteraction);
    assert.strictEqual(title, 'Keyboard');
  });

  it('returns "Other" as the title for unknown event types', async () => {
    const {interactionsTrackAppender, traceParsedData} =
        await renderTrackAppender('slow-interaction-button-click.json.gz');

    // Copy the event so we do not modify the actual trace data, and fake its
    // interaction type to be unexpected.
    const firstInteraction = {...traceParsedData.UserInteractions.interactionEvents[0]};
    firstInteraction.type = 'unknown';

    const title = interactionsTrackAppender.titleForEvent(firstInteraction);
    assert.strictEqual(title, 'Other');
  });

  it('highlightedEntryInfo returns the correct information', async () => {
    const {interactionsTrackAppender, traceParsedData} =
        await renderTrackAppender('slow-interaction-button-click.json.gz');
    const firstInteraction = traceParsedData.UserInteractions.interactionEvents[0];
    const highlightedEntryInfo = interactionsTrackAppender.highlightedEntryInfo(firstInteraction);
    // The i18n encodes spaces using the u00A0 unicode character.
    assert.strictEqual(highlightedEntryInfo.formattedTime, ('31.72\u00A0ms'));
  });
});
