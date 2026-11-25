const fs = require('node:fs');
const path = require('node:path');

module.exports = ({config}) => {
  const providedConfig = process.env.GOOGLE_SERVICES_JSON;
  const localConfig = path.join(__dirname,'google-services.json');
  return {
    ...config,
    android: {
      ...config.android,
      googleServicesFile: providedConfig || (fs.existsSync(localConfig) ? './google-services.json' : undefined)
    }
  };
};
