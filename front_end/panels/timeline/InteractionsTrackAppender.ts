// Copyright 2023 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.
import * as TraceEngine from '../../models/trace/trace.js';
import type * as PerfUI from '../../ui/legacy/components/perf_ui/perf_ui.js';

import {
  EntryType,
  type TimelineFlameChartEntry,
} from './TimelineFlameChartDataProvider.js';
import {
  type CompatibilityTracksAppender,
  type TrackAppender,
  type HighlightedEntryInfo,
  type TrackAppenderName,
} from './CompatibilityTracksAppender.js';
import * as ThemeSupport from '../../ui/legacy/theme_support/theme_support.js';
import * as i18n from '../../core/i18n/i18n.js';
import * as Common from '../../core/common/common.js';
import type * as TimelineModel from '../../models/timeline_model/timeline_model.js';

const UIStrings = {
  /**
   *@description Text in Timeline Flame Chart Data Provider of the Performance panel
   */
  interactions: 'Interactions',
  /**
   * @description Text in the Performance panel to show how long was spent in a particular part of the code.
   * The first placeholder is the total time taken for this node and all children, the second is the self time
   * (time taken in this node, without children included).
   *@example {10ms} PH1
   *@example {10ms} PH2
   */
  sSelfS: '{PH1} (self {PH2})',
};

const str_ = i18n.i18n.registerUIStrings('panels/timeline/InteractionsTrackAppender.ts', UIStrings);
const i18nString = i18n.i18n.getLocalizedString.bind(undefined, str_);

export class InteractionsTrackAppender implements TrackAppender {
  readonly appenderName: TrackAppenderName = 'Interactions';

  #colorGenerator: Common.Color.Generator;
  #compatibilityBuilder: CompatibilityTracksAppender;
  #flameChartData: PerfUI.FlameChart.TimelineData;
  #traceParsedData: Readonly<TraceEngine.TraceModel.PartialTraceParseDataDuringMigration>;
  #entryData: TimelineFlameChartEntry[];
  // TODO(crbug.com/1416533)
  // These are used only for compatibility with the legacy flame chart
  // architecture of the panel. Once all tracks have been migrated to
  // use the new engine and flame chart architecture, the reference can
  // be removed.
  #legacyEntryTypeByLevel: EntryType[];
  #legacyTrack: TimelineModel.TimelineModel.Track|null;

  constructor(
      compatibilityBuilder: CompatibilityTracksAppender, flameChartData: PerfUI.FlameChart.TimelineData,
      traceParsedData: TraceEngine.TraceModel.PartialTraceParseDataDuringMigration,
      entryData: TimelineFlameChartEntry[], legacyEntryTypeByLevel: EntryType[],
      legacyTrack?: TimelineModel.TimelineModel.Track) {
    this.#compatibilityBuilder = compatibilityBuilder;
    this.#colorGenerator = new Common.Color.Generator(
        {
          min: 30,
          max: 55,
          count: undefined,
        },
        {min: 70, max: 100, count: 6}, 50, 0.7);
    this.#flameChartData = flameChartData;
    this.#traceParsedData = traceParsedData;
    this.#entryData = entryData;
    this.#legacyEntryTypeByLevel = legacyEntryTypeByLevel;
    this.#legacyTrack = legacyTrack || null;
  }

  /**
   * Appends into the flame chart data the data corresponding to the
   * timings track.
   * @param level the horizontal level of the flame chart events where
   * the track's events will start being appended.
   * @param expanded wether the track should be rendered expanded.
   * @returns the first available level to append more data after having
   * appended the track's events.
   */
  appendTrackAtLevel(currentLevel: number, expanded?: boolean): number {
    if (this.#traceParsedData.UserInteractions.interactionEvents.length === 0) {
      return currentLevel;
    }
    this.#appendTrackHeaderAtLevel(currentLevel, expanded);
    return this.#appendInteractionsAtLevel(currentLevel);
  }

  /**
   * Adds into the flame chart data the header corresponding to the
   * timings track. A header is added in the shape of a group in the
   * flame chart data. A group has a predefined style and a reference
   * to the definition of the legacy track (which should be removed
   * in the future).
   * @param currentLevel the flame chart level at which the header is
   * appended.
   */
  #appendTrackHeaderAtLevel(currentLevel: number, expanded?: boolean): void {
    const trackIsCollapsible = this.#traceParsedData.UserInteractions.interactionEvents.length > 0;
    const style: PerfUI.FlameChart.GroupStyle = {
      padding: 4,
      height: 17,
      collapsible: trackIsCollapsible,
      color: ThemeSupport.ThemeSupport.instance().getComputedValue('--color-text-primary'),
      backgroundColor: ThemeSupport.ThemeSupport.instance().getComputedValue('--color-background'),
      nestingLevel: 0,
      shareHeaderLine: true,
      useFirstLineForOverview: true,
    };
    const group = ({
      startLevel: currentLevel,
      name: i18nString(UIStrings.interactions),
      style: style,
      selectable: true,
      expanded,
    } as PerfUI.FlameChart.Group);
    this.#flameChartData.groups.push(group);
    group.track = this.#legacyTrack;
  }

  /**
   * Adds into the flame chart data the trace events corresponding to
   * user timings (performance.measure and performance.mark). These are
   * taken straight from the UserTimings handler.
   * @param currentLevel the flame chart level from which user timings will
   * be appended.
   * @returns the next level after the last occupied by the appended
   * timings (the first available level to append more data).
   */
  /**
   * Adds into the flame chart data the trace events dispatched by the
   * performace.measure API. These events are taken from the UserTimings
   * handler.
   * @param currentLevel the flame chart level from which timings will
   * be appended.
   * @returns the next level after the last occupied by the appended
   * timings (the first available level to append more data).
   */

  #appendInteractionsAtLevel(currentLevel: number): number {
    const interactions = this.#traceParsedData.UserInteractions.interactionEvents;
    const lastUsedTimeByLevel: number[] = [];
    for (let i = 0; i < interactions.length; ++i) {
      const event = interactions[i];
      const startTime = event.ts;
      let level;
      // look vertically for the first level where this event fits,
      // that is, where it wouldn't overlap with other events.
      for (level = 0; level < lastUsedTimeByLevel.length && lastUsedTimeByLevel[level] > startTime; ++level) {
      }
      this.#appendEventAtLevel(event, currentLevel + level);
      const endTime = event.ts + (event.dur || 0);
      lastUsedTimeByLevel[level] = endTime;
    }
    this.#legacyEntryTypeByLevel.length = currentLevel + lastUsedTimeByLevel.length;
    // Set the entry type to TrackAppender for all the levels occupied by the appended timings.
    this.#legacyEntryTypeByLevel.fill(EntryType.TrackAppender, currentLevel);
    return currentLevel + lastUsedTimeByLevel.length;
  }

  /**
   * Adds an event to the flame chart data at a defined level.
   * @returns the position occupied by the new event in the entryData
   * array, which contains all the events in the timeline.
   */
  #appendEventAtLevel(event: TraceEngine.Types.TraceEvents.TraceEventData, level: number): number {
    this.#compatibilityBuilder.registerTrackForLevel(level, this);
    const index = this.#entryData.length;
    this.#entryData.push(event);
    this.#legacyEntryTypeByLevel[level] = EntryType.TrackAppender;
    this.#flameChartData.entryLevels[index] = level;
    this.#flameChartData.entryStartTimes[index] = TraceEngine.Helpers.Timing.microSecondsToMilliseconds(event.ts);
    const msDuration = event.dur || TraceEngine.Types.Timing.MicroSeconds(0);
    this.#flameChartData.entryTotalTimes[index] = TraceEngine.Helpers.Timing.microSecondsToMilliseconds(msDuration);
    return index;
  }

  /*
    ------------------------------------------------------------------------------------
     The following methods  are invoked by the flame chart renderer to query features about
     events on rendering.
    ------------------------------------------------------------------------------------
  */

  /**
   * Gets the color an event added by this appender should be rendered with.
   */
  colorForEvent(event: TraceEngine.Types.TraceEvents.TraceEventData): string {
    return this.#colorGenerator.colorForID(this.titleForEvent(event));
  }

  /**
   * Gets the title an event added by this appender should be rendered with.
   */
  titleForEvent(event: TraceEngine.Types.TraceEvents.TraceEventData): string {
    if (TraceEngine.Handlers.ModelHandlers.UserInteractions.eventIsInteractionEvent(event)) {
      let eventText = 'Interaction';
      if (event.args.data?.type) {
        eventText += ` type:${event.args.data.type}`;
      }
      eventText += ` id:${event.interactionId}`;
      return eventText;
    }
    return event.name;
  }

  /**
   * Returns the info shown when an event added by this appender
   * is hovered in the timeline.
   */
  highlightedEntryInfo(event: TraceEngine.Types.TraceEvents.TraceEventData): HighlightedEntryInfo {
    const title = this.titleForEvent(event);
    const totalTime = TraceEngine.Helpers.Timing.microSecondsToMilliseconds(
        (event.dur || 0) as TraceEngine.Types.Timing.MicroSeconds);
    const selfTime = totalTime;
    if (totalTime === TraceEngine.Types.Timing.MilliSeconds(0)) {
      return {title, formattedTime: ''};
    }
    const minSelfTimeSignificance = 1e-6;
    const time = Math.abs(totalTime - selfTime) > minSelfTimeSignificance && selfTime > minSelfTimeSignificance ?
        i18nString(UIStrings.sSelfS, {
          PH1: i18n.TimeUtilities.millisToString(totalTime, true),
          PH2: i18n.TimeUtilities.millisToString(selfTime, true),
        }) :
        i18n.TimeUtilities.millisToString(totalTime, true);
    return {title, formattedTime: time};
  }
}
