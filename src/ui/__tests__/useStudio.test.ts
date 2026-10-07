import { describe, expect, it } from 'vitest';
import { useStudio, type StudioDependencies } from '../useStudio';
import { coverPresetFor } from '../../core/cover-presets';
import type { CoverConfig, VoiceMeme } from '../../core/models';

function dependencies(overrides: Partial<StudioDependencies> = {}): StudioDependencies {
  const saved: VoiceMeme[] = [];
  return {
    recorder: { isRecording: false, start: async () => {}, stop: async () => new Blob(['voice'], { type: 'audio/webm' }) },
    analyzer: { analyze: async () => ({ duration: 2, features: { loudness:.75,dynamics:.55,pitch:.8,zeroCrossing:.62,pauseRatio:.12,tempoVariation:.6 } }) },
    cropper: { inspect: async () => ({duration:2,needsCrop:false}), crop: async (blob, range) => ({blob,duration:range.end-range.start}) },
    renderer: { render: async () => new Blob(['cover'], { type: 'image/png' }) },
    repository: { list: async()=>saved, save: async(m)=>{saved.push(m)}, rename:async()=>{}, delete:async()=>{} },
    share: { share: async () => 'shared' },
    ...overrides,
  };
}

function readyToSave(studio: ReturnType<typeof useStudio>) {
  studio.draft.audio = new Blob(['a']); studio.draft.duration = 1; studio.draft.title = '旧名称';
  studio.cover.value = { ...coverPresetFor('元气满满'), bubbleText: '旧气泡' };
  studio.emotion.value = { label:'元气满满',confidence:.9,explanation:'测试',scores:{'暴躁老哥':0,'温柔姐姐':0,'阴阳怪气':0,'元气满满':1} };
  studio.features.value = { loudness:.5,dynamics:.5,pitch:.5,zeroCrossing:.5,pauseRatio:.1,tempoVariation:.5 };
  studio.stage.value = 'cover';
}

function putRepository(saved: VoiceMeme[]) {
  return { list: async()=>saved, save: async(m:VoiceMeme)=>{const i=saved.findIndex(x=>x.id===m.id);if(i>=0)saved[i]=m;else saved.push(m)}, rename:async()=>{}, delete:async()=>{} };
}

describe('useStudio', () => {
  it('turns microphone denial into a recoverable error', async () => {
    const studio = useStudio(dependencies({ recorder: { isRecording:false, start:async()=>{throw new DOMException('denied','NotAllowedError')}, stop:async()=>new Blob() } }));
    await studio.startRecording();
    expect(studio.error.value).toContain('麦克风权限');
    expect(studio.stage.value).toBe('record');
  });
  it('moves recording through crop and emotion with manual override', async () => {
    const studio = useStudio(dependencies()); await studio.startRecording(); await studio.stopRecording();
    expect(studio.stage.value).toBe('crop'); await studio.analyze(); expect(studio.emotion.value?.label).toBe('元气满满');
    studio.selectEmotion('温柔姐姐'); expect(studio.cover.value.label).toBe('温柔姐姐'); expect(studio.stage.value).toBe('emotion');
  });
  it('keeps the draft when saving fails and can edit an existing work', async () => {
    const studio = useStudio(dependencies({ repository: { list:async()=>[], save:async()=>{throw new DOMException('full','QuotaExceededError')}, rename:async()=>{}, delete:async()=>{} } }));
    studio.draft.audio = new Blob(['a']); studio.draft.duration = 1; studio.cover.value = coverPresetFor('温柔姐姐'); studio.emotion.value = { label:'温柔姐姐',confidence:.8,explanation:'柔和',scores:{'暴躁老哥':0,'温柔姐姐':1,'阴阳怪气':0,'元气满满':0} };
    studio.features.value = { loudness:.2,dynamics:.2,pitch:.4,zeroCrossing:.2,pauseRatio:.3,tempoVariation:.2 };
    await studio.save(); expect(studio.error.value).toContain('保存失败'); expect(studio.draft.audio?.size).toBe(1);
    const existing = { id:'old',title:'旧作品',emotion:'温柔姐姐' as const,confidence:.8,features:{loudness:.2,dynamics:.2,pitch:.4,zeroCrossing:.2,pauseRatio:.3,tempoVariation:.2},audio:new Blob(['a']),duration:1,cover:new Blob(['c']),coverConfig:coverPresetFor('温柔姐姐'),createdAt:'2026-10-05' };
    studio.editMeme(existing); expect(studio.draft.title).toBe('旧作品'); expect(studio.stage.value).toBe('cover');
  });
  it('saves a consistent snapshot even when the user edits during rendering', async () => {
    let releaseRender!: () => void; const gate = new Promise<void>((resolve) => { releaseRender = resolve; });
    const saved: VoiceMeme[] = []; const rendered: CoverConfig[] = [];
    const studio = useStudio(dependencies({
      renderer: { render: async (config) => { rendered.push({ ...config }); await gate; return new Blob(['cover'], { type: 'image/png' }); } },
      repository: putRepository(saved),
    }));
    readyToSave(studio);
    const pending = studio.save();
    studio.updateTitle('新名称'); studio.patchCover({ bubbleText: '新气泡' });
    releaseRender(); await pending;
    expect(saved).toHaveLength(1);
    expect(rendered[0].bubbleText).toBe('旧气泡');
    expect(saved[0].title).toBe('旧名称'); expect(saved[0].coverConfig.bubbleText).toBe('旧气泡');
    expect(saved[0].coverConfig).toEqual(rendered[0]);
    expect(studio.stage.value).toBe('cover'); expect(studio.notice.value).toContain('尚未保存');
    await studio.save();
    expect(saved).toHaveLength(1); expect(saved[0].title).toBe('新名称'); expect(saved[0].coverConfig.bubbleText).toBe('新气泡');
    expect(studio.stage.value).toBe('collection');
  });
  it('ignores repeated save clicks while a save is in flight', async () => {
    let releaseRender!: () => void; const gate = new Promise<void>((resolve) => { releaseRender = resolve; });
    const saved: VoiceMeme[] = [];
    const studio = useStudio(dependencies({ renderer: { render: async () => { await gate; return new Blob(['cover'], { type: 'image/png' }); } }, repository: putRepository(saved) }));
    readyToSave(studio);
    const first = studio.save(); const second = studio.save();
    releaseRender(); await Promise.all([first, second]);
    expect(saved).toHaveLength(1);
  });
  it('keeps a successful save when the list refresh fails and retries update the same work', async () => {
    const saved: VoiceMeme[] = []; let listCalls = 0;
    const repository = { ...putRepository(saved), list: async () => { listCalls++; if (listCalls === 1) throw new Error('indexeddb busy'); return saved; } };
    const studio = useStudio(dependencies({ repository }));
    readyToSave(studio);
    await studio.save();
    expect(studio.error.value).toBe(''); expect(studio.notice.value).toContain('已保存'); expect(saved).toHaveLength(1);
    await studio.save();
    expect(saved).toHaveLength(1); expect(studio.error.value).toBe(''); expect(studio.stage.value).toBe('collection');
  });
});
