/* Auto Simulator — field definitions (WPILib blue-origin coordinates, metres).
 * 2024 and 2026 images come from AdvantageScope's field assets (top-down renders shared on
 * Chief Delphi); 2025 is the official WPILib image. redSide = image is drawn from the red side. */
(function () {
  'use strict';
  const AC = (window.AC = window.AC || {});

  AC.fields = {
    list: [
      { id: '2026', name: '2026 REBUILT', length: 16.541, width: 8.069, autoTime: 20, image: 'fields/2026-rebuilt.png', redSide: true, px: { top: 95, left: 524, bottom: 1489, right: 3378 } },
      { id: '2025', name: '2025 Reefscape', length: 17.548, width: 8.052, autoTime: 15, image: 'fields/2025-reefscape.png', redSide: true, px: { top: 289, left: 534, bottom: 1636, right: 3466 } },
      { id: '2024', name: '2024 Crescendo', length: 16.541, width: 8.211, autoTime: 15, image: 'fields/2024-crescendo.png', redSide: true, px: { top: 78, left: 513, bottom: 1475, right: 3327 } },
    ],
    get(id) {
      return this.list.find((f) => f.id === id) || this.list[0];
    },
  };
})();
