const fs = require('node:fs');
const path = require('node:path');

module.exports = ({config}) => {
  const providedConfig = process.env.GOOGLE_SERVICES_JSON;
  const localConfig = path.join(__dirname,'google-services.json');
  const buildCode = process.env.ARKAB_ANDROID_VERSION_CODE;
  if (buildCode && (!/^\d+$/.test(buildCode) || Number(buildCode)<1 || Number(buildCode)>2100000000)) {
    throw new Error('Invalid ARKAB_ANDROID_VERSION_CODE');
  }
  return {
    ...config,
    android: {
      ...config.android,
      ...(buildCode ? {versionCode:Number(buildCode)} : {}),
      googleServicesFile: providedConfig || (fs.existsSync(localConfig) ? './google-services.json' : undefined)
    }
  };
};
