// Render the real Main function in Node with inert native APIs and hooks.
// No network, native permission changes, or fake production sessions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {transformSync} from '@babel/core';
const require=createRequire(import.meta.url);
const root=path.dirname(fileURLToPath(new URL('../App.js',import.meta.url)));
const inert=()=>{};
let index=0,overrides=[];
const hooks={
  createContext:()=>({Provider:'ContextProvider'}),useContext:()=>false,
  createElement:(type,props,...children)=>({type,props,children}),
  useState:(initial)=>{const i=index++;return [i<overrides.length?overrides[i]:typeof initial==='function'?initial():initial,inert];},
  useRef:current=>({current}),useEffect:inert,useCallback:fn=>fn,useMemo:fn=>fn()
};
const native={StyleSheet:{create:s=>s,flatten:s=>s},AppState:{currentState:'active'},Platform:{OS:'android'}};
for(const name of ['View','Text','TextInput','TouchableOpacity','ScrollView','Image','ActivityIndicator','StatusBar','Pressable'])native[name]=name;
const stubs={
  react:hooks,'react-native':native,'react-native-url-polyfill/auto':{},
  'react-native-safe-area-context':{SafeAreaView:'SafeAreaView',SafeAreaProvider:'SafeAreaProvider'},
  '@supabase/supabase-js':{createClient:()=>({})},'expo-task-manager':{isTaskDefined:()=>false,defineTask:inert},
  'expo-notifications':{setNotificationHandler:inert},'expo-font':{useFonts:()=>[true]},
  'expo-location':{},'expo-secure-store':{},'expo-local-authentication':{},'expo-image-picker':{},'expo-crypto':{},
  '@maplibre/maplibre-react-native':{Map:'Map',Camera:'Camera',Marker:'Marker',GeoJSONSource:'GeoJSONSource',Layer:'Layer'}
};
const cache=new Map();
function load(filename){
  if(cache.has(filename))return cache.get(filename).exports;
  const mod={exports:{}};cache.set(filename,mod);
  const isApp=filename===path.join(root,'App.js');
  const source=fs.readFileSync(filename,'utf8')+(isApp?'\nexport {Main as StartupMain};':'');
  const {code}=transformSync(source,{filename,configFile:false,babelrc:false,plugins:['@babel/plugin-transform-react-jsx','@babel/plugin-transform-modules-commonjs']});
  const localRequire=name=>{
    if(Object.hasOwn(stubs,name))return stubs[name];
    if(name.startsWith('@expo/vector-icons/')||name==='./SplashIntro')return 'Icon';
    if(/\.(ttf|png|jpg|jpeg|webp)$/.test(name))return 1;
    if(name.endsWith('.json'))return JSON.parse(fs.readFileSync(path.resolve(path.dirname(filename),name),'utf8'));
    if(name.startsWith('.'))return load(path.resolve(path.dirname(filename),name.endsWith('.js')?name:name+'.js'));
    throw Error('Unexpected test dependency: '+name);
  };
  vm.runInThisContext('(function(require,module,exports){'+code+'\n})',{filename})(localRequire,mod,mod.exports);return mod.exports;
}
const {StartupMain}=load(path.join(root,'App.js'));
for(const scenario of [
  {name:'first cold render',override:[null,null,true]},
  {name:'signed-out login screen',override:[null,null,false]},
  {name:'restored session without profile',override:[{user:{id:'test-rider',email:'test@example.invalid'}},null,true]},
  {name:'restored passenger without active trip',override:[{user:{id:'test-rider',email:'test@example.invalid'}},{id:'test-rider',role:'passenger'},false]}
]){
  index=0;overrides=scenario.override;
  assert.doesNotThrow(()=>StartupMain(),scenario.name);
}
console.log('PASS: real Main render on cold start, signed out and restored session without a ride.');
