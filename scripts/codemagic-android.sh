#!/usr/bin/env bash
# No EAS cloud build, no secret output, and no auto-submission to Google Play.
set -euo pipefail
cd "$(dirname "$0")/.."
case "${1:-}" in
  configure)
    : "${CM_KEYSTORE_PATH:?Upload existing ARKAB Android keystore as arkab-release}"
    : "${CM_KEYSTORE_PASSWORD:?Missing keystore password}"
    : "${CM_KEY_ALIAS:?Missing key alias}"
    : "${CM_KEY_PASSWORD:?Missing key password}"
    test -f "$CM_KEYSTORE_PATH" || { echo 'Existing ARKAB signing file not found'; exit 1; }
    : "${ARKAB_GOOGLE_SERVICES_JSON:?Add Firebase google-services.json to arkab_firebase group}"
    node <<'NODE'
const fs = require('node:fs');
let config;
try { config=JSON.parse(process.env.ARKAB_GOOGLE_SERVICES_JSON); }
catch { console.error('Invalid ARKAB_GOOGLE_SERVICES_JSON: use the raw JSON file contents.');process.exit(1); }
if(!config.project_info?.project_number || !Array.isArray(config.client) || !config.client.some(c=>c?.client_info?.android_client_info?.package_name==='com.arkab.managil')){
  console.error('Firebase Android config does not match com.arkab.managil.');process.exit(1);
}
fs.writeFileSync('google-services.json', JSON.stringify(config),{mode:0o600});
NODE
    echo 'Configuration validated; signing and Firebase files remain private.'
    ;;
  build)
    test -f google-services.json || { echo 'Missing Firebase config; run configure step'; exit 1; }
    : "${PROJECT_BUILD_NUMBER:?Missing Codemagic project build number}"
    : "${ARKAB_BUILD_TARGET:?Expected apk or aab}"
    : "${ANDROID_SDK_ROOT:?Missing Android SDK}"
    # Start safely above historical Expo build codes. One sequence for both workflows.
    export ARKAB_ANDROID_VERSION_CODE=$((100 + PROJECT_BUILD_NUMBER))
    export GOOGLE_SERVICES_JSON="$PWD/google-services.json"
    CI=1 npx --no-install expo prebuild --platform android --clean --no-install
    test -f android/app/google-services.json || { echo 'Firebase config was not copied'; exit 1; }
    # Override Expo template's debug signing for release only, without embedding keys.
    cat >> android/app/build.gradle <<'GRADLE'

// Codemagic release identity: the original ARKAB Android key.
android {
    signingConfigs {
        arkabRelease {
            storeFile file(System.getenv("CM_KEYSTORE_PATH"))
            storePassword System.getenv("CM_KEYSTORE_PASSWORD")
            keyAlias System.getenv("CM_KEY_ALIAS")
            keyPassword System.getenv("CM_KEY_PASSWORD")
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.arkabRelease
        }
    }
}
GRADLE
    mkdir -p artifacts
    version=$(node -p "require('./app.json').expo.version")
    case "$ARKAB_BUILD_TARGET" in
      apk)
        (cd android && ./gradlew --no-daemon :app:assembleRelease)
        apk=android/app/build/outputs/apk/release/app-release.apk
        test -f "$apk"
        signer=$(find "$ANDROID_SDK_ROOT/build-tools" -type f -name apksigner | sort | tail -n 1)
        test -n "$signer"
        "$signer" verify "$apk"
        output="artifacts/ARKAB-v${version}-build${ARKAB_ANDROID_VERSION_CODE}.apk"
        cp "$apk" "$output"
        ;;
      aab)
        (cd android && ./gradlew --no-daemon :app:bundleRelease)
        aab=android/app/build/outputs/bundle/release/app-release.aab
        test -f "$aab"
        jarsigner -verify "$aab"
        output="artifacts/ARKAB-v${version}-build${ARKAB_ANDROID_VERSION_CODE}.aab"
        cp "$aab" "$output"
        ;;
      *) echo 'Unknown build target'; exit 1 ;;
    esac
    shasum -a 256 "$output" > "$output.sha256"
    ;;
  *) echo 'Expected configure or build'; exit 1 ;;
esac
