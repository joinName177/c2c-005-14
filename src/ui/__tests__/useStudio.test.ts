import { describe, expect, it } from 'vitest';
import { useStudio, type StudioDependencies } from '../useStudio';
import { coverPresetFor } from '../../core/cover-presets';
import type { CoverConfig, VoiceMeme } from '../../core/models';

function deferred<T>() { let resolve!: (v: T) => void; let reject!: (e?: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }
function seed(studio: ReturnType<typeof useStudio>, overrides: { title?: string; bubble?: string } = {}) {
  studio.draft.audio = new Blob(['voice-audio'], { type: 'audio/webm' }); studio.draft.duration = 2;
  studio.draft.title = overrides.title ?? '原名称';
  studio.cover.value = { ...coverPresetFor('温柔姐姐'), bubbleText: overrides.bubble ?? '旧气泡' };
  studio.emotion.value = { label:'温柔姐姐',confidence:.8,explanation:'柔和',scores:{'暴躁老哥':0,'温柔姐姐':1,'阴阳怪气':0,'元气满满':0} };
  studio.features.value = { loudness:.2,dynamics:.2,pitch:.4,zeroCrossing:.2,pauseRatio:.3,tempoVariation:.2 };
  studio.stage.value = 'cover';
}

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
  it('binds cover image, audio, title and analysis basis to one save snapshot even if edited during render', async () => {
    const renderConfig = deferred<CoverConfig>();
    const saved: VoiceMeme[] = [];
    const studio = useStudio(dependencies({
      renderer: { render: async (config) => { renderConfig.resolve(config); await new Promise((r) => setTimeout(r, 5)); return new Blob(['cover-png'], { type: 'image/png' }); } },
      repository: { list: async () => saved, save: async (m) => { saved.push(m); }, rename: async () => {}, delete: async () => {} },
    }));
    seed(studio);
    const pending = studio.save();
    // 渲染尚未完成（真实场景下界面已锁定），此时即使状态发生变化也不能污染本次保存
    const configAtRender = await renderConfig.promise;
    studio.draft.title = '新名称';
    studio.cover.value = { ...studio.cover.value, bubbleText: '新气泡' };
    await pending;
    expect(configAtRender.bubbleText).toBe('旧气泡');
    expect(saved).toHaveLength(1);
    expect(saved[0].title).toBe('原名称');
    expect(saved[0].coverConfig.bubbleText).toBe('旧气泡');
    expect(saved[0].cover.size).toBe(new Blob(['cover-png'], { type: 'image/png' }).size);
    expect(saved[0].audio.size).toBe(new Blob(['voice-audio'], { type: 'audio/webm' }).size);
    expect(saved[0].features.loudness).toBe(.2);
    expect(studio.stage.value).toBe('collection');
  });
  it('ignores repeated save clicks and never writes duplicate works', async () => {
    let renderStarted = 0;
    const saved: VoiceMeme[] = [];
    const studio = useStudio(dependencies({
      renderer: { render: async () => { renderStarted += 1; await new Promise((r) => setTimeout(r, 5)); return new Blob(['cover']); } },
      repository: { list: async () => saved, save: async (m) => { saved.push(m); }, rename: async () => {}, delete: async () => {} },
    }));
    seed(studio);
    await Promise.all([studio.save(), studio.save(), studio.save()]);
    expect(renderStarted).toBe(1);
    expect(saved).toHaveLength(1);
    expect(studio.saving.value).toBe(false);
  });
  it('keeps the saved work and switches to collection when list refresh fails', async () => {
    let listCalls = 0;
    const saved: VoiceMeme[] = [];
    const studio = useStudio(dependencies({
      repository: { list: async () => { listCalls += 1; if (listCalls === 1) throw new Error('refresh boom'); return saved; }, save: async (m) => { saved.push(m); }, rename: async () => {}, delete: async () => {} },
    }));
    seed(studio);
    await studio.save();
    expect(saved).toHaveLength(1);
    expect(studio.stage.value).toBe('collection');
    expect(studio.notice.value).toContain('已保存');
    expect(studio.collectionError.value).toContain('列表刷新失败');
    expect(studio.error.value).toBe('');
    // 重试刷新成功后清除错误，不产生重复写入
    await studio.loadCollection();
    expect(studio.collectionError.value).toBe('');
    expect(studio.collection.value).toHaveLength(1);
    expect(saved).toHaveLength(1);
  });
  it('editing an existing work overwrites the same record and keeps createdAt', async () => {
    const existing: VoiceMeme = { id:'old', title:'旧作品', emotion:'温柔姐姐' as const, confidence:.8, features:{loudness:.2,dynamics:.2,pitch:.4,zeroCrossing:.2,pauseRatio:.3,tempoVariation:.2}, audio:new Blob(['old-audio']), duration:1, cover:new Blob(['old-cover']), coverConfig:coverPresetFor('温柔姐姐'), createdAt:'2026-01-01T00:00:00.000Z' };
    const saved: VoiceMeme[] = [existing];
    const studio = useStudio(dependencies({
      repository: { list: async () => saved, save: async (m) => { const i = saved.findIndex((w) => w.id === m.id); if (i >= 0) saved[i] = m; else saved.push(m); }, rename: async () => {}, delete: async () => {} },
    }));
    studio.editMeme(existing);
    studio.draft.title = '改过的名称';
    studio.cover.value = { ...studio.cover.value, bubbleText: '改过的气泡' };
    await studio.save();
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe('old');
    expect(saved[0].createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(saved[0].title).toBe('改过的名称');
    expect(saved[0].audio.size).toBe(new Blob(['old-audio']).size);
  });
  it('unlocks editing and preserves the full draft when rendering or writing fails, then can retry', async () => {
    let attempts = 0;
    const saved: VoiceMeme[] = [];
    const studio = useStudio(dependencies({
      renderer: { render: async (config) => { attempts += 1; if (attempts === 1) throw new Error('canvas gone'); return new Blob(['cover-png']); } },
      repository: { list: async () => saved, save: async (m) => { saved.push(m); }, rename: async () => {}, delete: async () => {} },
    }));
    seed(studio);
    await studio.save();
    expect(studio.saving.value).toBe(false);
    expect(studio.stage.value).toBe('cover');
    expect(studio.error.value).toContain('保存失败');
    expect(studio.draft.audio).toBeTruthy();
    expect(studio.features.value).toBeTruthy();
    expect(studio.emotion.value).toBeTruthy();
    expect(saved).toHaveLength(0);
    // 内容原样保留，解锁后重试成功
    await studio.save();
    expect(saved).toHaveLength(1);
    expect(studio.stage.value).toBe('collection');
  });
});
