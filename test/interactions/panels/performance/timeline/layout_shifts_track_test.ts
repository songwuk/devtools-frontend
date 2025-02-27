// Copyright 2023 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import {waitFor} from '../../../../shared/helper.js';
import {describe} from '../../../../shared/mocha-extensions.js';
import {assertElementScreenshotUnchanged, itScreenshot} from '../../../../shared/screenshots.js';
import {loadComponentDocExample, preloadForCodeCoverage} from '../../../helpers/shared.js';

describe('Layout shifts track', () => {
  preloadForCodeCoverage('performance_panel/track_example.html');

  itScreenshot('renders the layout shifts track correctly', async () => {
    await loadComponentDocExample('performance_panel/track_example.html?track=LayoutShifts&fileName=cls-single-frame');
    const flameChart = await waitFor('.flame-chart-main-pane');
    await assertElementScreenshotUnchanged(flameChart, 'performance/layout_shifts_track.png', 2);
  });
});
