import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import parser from '@babel/parser';
import {validPoint,parseRoadRoute} from '../roadRoute.js';

for(const file of ['App.js','rideFeatures.js','roadRoute.js','SplashIntro.js']){
  parser.parse(readFileSync(new URL('../'+file,import.meta.url),'utf8'),{sourceType:'module',plugins:['jsx']});
}
assert.equal(validPoint([32.98,14.25]),true);
assert.equal(validPoint([Infinity,14]),false);
assert.equal(validPoint([181,14]),false);
assert.equal(parseRoadRoute({code:'NoRoute'}),null);
const mockRoute={code:'Ok',routes:[{distance:3500,duration:600,geometry:{coordinates:[[32.98,14.25],[32.99,14.26]]}}]};
assert.equal(parseRoadRoute(mockRoute).distanceKm,3.5);
assert.equal(parseRoadRoute(mockRoute).durationMin,10);
assert.equal(parseRoadRoute({code:'Ok',routes:[{distance:500,duration:0,geometry:{coordinates:[[32,14],[33,14]]}}]}),null);
assert.equal(parseRoadRoute({code:'Ok',routes:[{distance:500,duration:20,geometry:{coordinates:[[32,14],[900,14]]}}]}),null);
const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
const app=JSON.parse(readFileSync(new URL('../app.json',import.meta.url),'utf8'));
const lock=JSON.parse(readFileSync(new URL('../package-lock.json',import.meta.url),'utf8'));
assert.equal(pkg.version,app.expo.version);
assert.equal(lock.packages[''].version,pkg.version);
console.log('ARKAB v0.8 source and route checks passed.');
