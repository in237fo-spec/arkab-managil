import React, {useEffect, useRef, useState} from 'react';
import {View, Text, StyleSheet, StatusBar, Image} from 'react-native';
import * as SplashScreen from 'expo-splash-screen';
import Animated, {
  Easing, useAnimatedStyle, useReducedMotion, useSharedValue,
  withDelay, withTiming
} from 'react-native-reanimated';

const GREEN = '#06432D';
const GOLD = '#FFB600';
const ease = Easing.bezier(0.23, 1, 0.32, 1);
const logo = require('./assets/logo.png');

// Keep the branded native launch screen until the local artwork is rendered.
void SplashScreen.preventAutoHideAsync().catch(() => {});
SplashScreen.setOptions({fade: false, duration: 0});

export default function SplashIntro({onFinish}) {
  const reduced = useReducedMotion();
  const [ready, setReady] = useState(false);
  const started = useRef(false);
  const logoScale = useSharedValue(1);
  const logoShift = useSharedValue(0);
  const line = useSharedValue(0);
  const caption = useSharedValue(0);
  const fade = useSharedValue(1);

  const logoStyle = useAnimatedStyle(() => ({
    transform: [{translateY: logoShift.get()}, {scale: logoScale.get()}]
  }));
  const lineStyle = useAnimatedStyle(() => ({
    opacity: line.get(),
    transform: [{translateX: -18 * (1 - line.get())}, {scaleX: 0.7 + 0.3 * line.get()}]
  }));
  const captionStyle = useAnimatedStyle(() => ({
    opacity: caption.get(),
    transform: [{translateY: reduced ? 0 : 9 * (1 - caption.get())}]
  }));
  const overlayStyle = useAnimatedStyle(() => ({opacity: fade.get()}));

  // The asset is bundled locally. The timeout also prevents a blocked launch
  // if the image load event is missed on an older Android device.
  useEffect(() => {
    const fallback = setTimeout(() => setReady(true), 800);
    return () => clearTimeout(fallback);
  }, []);

  useEffect(() => {
    if (!ready || started.current) return;
    started.current = true;
    void SplashScreen.hideAsync().catch(() => {});
    if (reduced) {
      caption.set(1);
      line.set(1);
      fade.set(withDelay(180, withTiming(0, {duration: 180, easing: ease})));
    } else {
      logoShift.set(withTiming(-18, {duration: 380, easing: ease}));
      logoScale.set(withTiming(1.10, {duration: 380, easing: ease}));
      line.set(withDelay(150, withTiming(1, {duration: 450, easing: ease})));
      caption.set(withDelay(410, withTiming(1, {duration: 360, easing: ease})));
      fade.set(withDelay(1200, withTiming(0, {duration: 280, easing: ease})));
    }
    const timer = setTimeout(onFinish, reduced ? 400 : 1500);
    return () => clearTimeout(timer);
  }, [ready, reduced, onFinish, logoShift, logoScale, line, caption, fade]);

  return (
    <Animated.View style={[styles.overlay, overlayStyle]} accessibilityLabel="أركب" testID="arkab-splash">
      <StatusBar barStyle="light-content"/>
      <Animated.View style={[styles.logoFrame, logoStyle]}>
        <Image source={logo} style={styles.logo} resizeMode="contain" onLoadEnd={() => setReady(true)}/>
      </Animated.View>
      <View style={styles.caption}>
        <Animated.View style={[styles.speed, lineStyle]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <View style={[styles.stroke, {width: 55}]}/>
          <View style={[styles.stroke, {width: 82}]}/>
          <View style={[styles.stroke, {width: 37}]}/>
        </Animated.View>
        <Animated.View style={captionStyle}>
          <Text style={styles.name}>ARKAB | أركب</Text>
          <Text style={styles.tagline}>المناقل • مشوارك بقى أسهل</Text>
        </Animated.View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {...StyleSheet.absoluteFillObject, zIndex: 100, backgroundColor: GREEN, alignItems: 'center', justifyContent: 'center'},
  logoFrame: {width: 200, height: 200, borderRadius: 24, overflow: 'hidden', backgroundColor: '#F8F7F2'},
  logo: {width: '100%', height: '100%'},
  caption: {position: 'absolute', top: '50%', marginTop: 115, alignItems: 'center', gap: 9, paddingHorizontal: 24},
  speed: {gap: 4, alignItems: 'center', marginBottom: 4},
  stroke: {height: 3, backgroundColor: GOLD, borderRadius: 2},
  name: {color: GOLD, fontSize: 25, fontWeight: '900', textAlign: 'center'},
  tagline: {color: '#FFFFFF', fontSize: 16, textAlign: 'center'}
});
