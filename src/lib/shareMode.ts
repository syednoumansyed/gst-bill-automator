/**
 * Share mode: the app is reachable on a public link without login.
 * Settings and the config API are switched off and nothing is synced to Airtable or Blob.
 */
export const isShareMode = () => process.env.SHARE_MODE === "1";
