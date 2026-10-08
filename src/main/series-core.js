'use strict';
// 시리즈 (에피소드 묶음) 의 순수 계산 부분: 값 정리(normalize)와 새 id 만들기. 파일·fs·Buffer 를 쓰지 않는다.
//  - 고정 주인공(캐릭터 파일) + 그림체 약속(스타일 바이블) + 에피소드 기록.
//  - PC 앱(series.js 의 SeriesStore)과 폰 앱(안드로이드 WebView, esbuild 묶음)이 같은 파일을 쓴다 (scripts/shared-modules.js · test/shared-purity.test.js).
//    자막 모양 정리는 shared/subtitle-style 의 normalizeStyle 을 그대로 쓴다.
//  - 디스크에 저장하는 SeriesStore 는 series.js 에 남아 있다 (폰은 같은 normalizeSeries 로 IndexedDB 에 저장한다).
const { DEFAULT_ART_STYLE } = require('./defaults');
const { normalizeStyle } = require('../shared/subtitle-style');

function clean(s, max = 1200) {
  return String(s == null ? '' : s).replace(/[ \t]+/g, ' ').trim().slice(0, max);
}

function normalizeEpisode(e) {
  return {
    number: Math.max(1, Math.floor(Number(e.number) || 1)),
    projectId: String(e.projectId || ''),
    title: clean(e.title, 80),
    summary_ko: clean(e.summary_ko, 400),
    madeAt: Number(e.madeAt) || Date.now(),
  };
}

/** 시리즈 전체의 기본 자막 모양 (정규화해서 저장, enabled 는 에피소드마다 따로 정하므로 뺀다). 없으면 null */
function normalizeSubtitleStyle(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const { enabled, ...look } = normalizeStyle(v); // eslint-disable-line no-unused-vars
  return look;
}

function normalizeSeries(o = {}) {
  const b = o.bible && typeof o.bible === 'object' ? o.bible : {};
  return {
    id: String(o.id || ''),
    name: clean(o.name, 60) || '새 시리즈',
    emoji: clean(o.emoji, 8) || '🌻',
    characterIds: (Array.isArray(o.characterIds) ? o.characterIds : []).map(String).filter(Boolean).slice(0, 4),
    bible: {
      art_en: clean(b.art_en, 800) || DEFAULT_ART_STYLE,
      world_ko: clean(b.world_ko, 800),
      tone_ko: clean(b.tone_ko, 400),
      notes_en: clean(b.notes_en, 800),
    },
    workflowId: String(o.workflowId || ''),
    subtitleStyle: normalizeSubtitleStyle(o.subtitleStyle),
    episodeCounter: Math.max(0, Math.floor(Number(o.episodeCounter) || 0)),
    episodes: (Array.isArray(o.episodes) ? o.episodes : []).map(normalizeEpisode).sort((a, b) => a.number - b.number),
    createdAt: Number(o.createdAt) || Date.now(),
    updatedAt: Number(o.updatedAt) || Date.now(),
  };
}

/** 새 시리즈 id: 'ser-' + 시각(36진수) + 무작위 4자리 (SeriesStore.save 와 폰이 같은 모양을 쓴다) */
function newSeriesId() {
  const b = new Uint8Array(2);
  globalThis.crypto.getRandomValues(b);
  return `ser-${Date.now().toString(36)}${Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('')}`;
}

module.exports = { clean, normalizeEpisode, normalizeSubtitleStyle, normalizeSeries, newSeriesId };
