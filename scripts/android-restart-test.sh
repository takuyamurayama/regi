#!/usr/bin/env bash
set -euo pipefail
export NODE_ENV=test
adb="${ANDROID_HOME:-$PWD/.context/android-sdk}/platform-tools/adb"
fixture="$(npx tsx scripts/android-fixture.ts)"
mkdir -p .context/verification
android/gradlew -p android assembleDebug assembleDebugAndroidTest --no-daemon -PregiRestartRunner=true
"$adb" install -r android/app/build/outputs/apk/debug/app-debug.apk
"$adb" install -r android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
"$adb" shell am instrument -w -e stage prepare -e regiTestFixture "'$fixture'" jp.regi.pos.test/jp.regi.pos.RestartRunner | tee .context/verification/android-restart-prepare.log
rg -q 'REGI_RESTART_SUCCESS:prepare' .context/verification/android-restart-prepare.log
"$adb" shell am force-stop jp.regi.pos
"$adb" shell am instrument -w -e stage recover -e regiTestFixture "'$fixture'" jp.regi.pos.test/jp.regi.pos.RestartRunner | tee .context/verification/android-restart-recover.log
rg -q 'REGI_RESTART_SUCCESS:recover' .context/verification/android-restart-recover.log
prepare_pid="$(awk -F'pid=' '/INSTRUMENTATION_RESULT: pid=/{print $2}' .context/verification/android-restart-prepare.log | tr -d '\r')"
recover_pid="$(awk -F'pid=' '/INSTRUMENTATION_RESULT: pid=/{print $2}' .context/verification/android-restart-recover.log | tr -d '\r')"
test -n "$prepare_pid" && test -n "$recover_pid" && test "$prepare_pid" != "$recover_pid"
printf 'Process death verified: %s -> %s; persisted unknown payment recovered without duplicate sale\n' "$prepare_pid" "$recover_pid"
