#!/usr/bin/env bash
set -euo pipefail
export NODE_ENV=test
fixture="$(npx tsx scripts/android-fixture.ts)"
mkdir -p .context
printf '%s\n' "$fixture" > .context/android-fixture.json
android/gradlew assembleDebug testDebugUnitTest connectedDebugAndroidTest --no-daemon "-PregiTestFixture=$fixture" "$@"
