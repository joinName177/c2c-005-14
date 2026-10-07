import { reactive, ref } from 'vue';
import { classifyEmotion } from '../core/emotion-engine';
import { coverPresetFor } from '../core/cover-presets';
import type { AudioFeatures, CoverConfig, EmotionLabel, EmotionResult, StudioStage, VoiceMeme } from '../core/models';
import type { RecorderPort } from '../ports/recorder.port';
import type { AudioAnalyzerPort } from '../ports/audio-analyzer.port';
import type { AudioCropperPort } from '../ports/audio-cropper.port';
import type { CoverRendererPort } from '../ports/cover-renderer.port';
import type { MemeRepository } from '../ports/meme-repository.port';
import type { SharePort } from '../ports/share.port';

export interface StudioDependencies { recorder: RecorderPort; analyzer: AudioAnalyzerPort; cropper: AudioCropperPort; renderer: CoverRendererPort; repository: MemeRepository; share: SharePort }
export function useStudio(deps: StudioDependencies) {
  const stage = ref<StudioStage>('record'); const error = ref(''); const notice = ref(''); const level = ref(0);
  const draft = reactive<{ id?: string; title: string; audio?: Blob; duration: number; cropStart: number; cropEnd: number; createdAt?: string }>({ title: '我的声音表情', duration: 0, cropStart: 0, cropEnd: 0 });
  const emotion = ref<EmotionResult>(); const features = ref<AudioFeatures>(); const cover = ref<CoverConfig>(coverPresetFor('元气满满')); const collection = ref<VoiceMeme[]>([]);
  // 保存进行中：锁定封面编辑，阻止并发保存
  const saving = ref(false);
  // 作品集列表自身的加载/刷新失败（与作品写入失败分开管理）
  const collectionError = ref('');

  async function startRecording() { error.value = ''; try { await deps.recorder.start((value) => { level.value = value; }); notice.value = '正在录音，最长 10 秒'; } catch { error.value = '无法使用麦克风权限，请在浏览器设置中允许访问或导入音频。'; } }
  async function stopRecording() { try { draft.audio = await deps.recorder.stop(); const info = await deps.cropper.inspect(draft.audio); draft.duration = info.duration; draft.cropStart = 0; draft.cropEnd = Math.min(10, info.duration); stage.value = 'crop'; notice.value = info.needsCrop ? '音频超过 10 秒，请选择保留片段' : '录音完成，可以试听并分析'; } catch (cause) { error.value = cause instanceof Error ? cause.message : '录音结束失败'; } }
  async function importAudio(blob: Blob) { draft.audio = blob; const info = await deps.cropper.inspect(blob); draft.duration = info.duration; draft.cropStart = 0; draft.cropEnd = Math.min(10, info.duration); stage.value = 'crop'; }
  async function analyze() { if (!draft.audio) { error.value = '请先录制或导入一段声音'; return; } const cropped = await deps.cropper.crop(draft.audio, { start: draft.cropStart, end: draft.cropEnd }); draft.audio = cropped.blob; draft.duration = cropped.duration; const result = await deps.analyzer.analyze(cropped.blob); features.value = result.features; emotion.value = classifyEmotion(result.features); cover.value = coverPresetFor(emotion.value.label); stage.value = 'emotion'; }
  function selectEmotion(label: EmotionLabel) { const current = emotion.value ?? classifyEmotion({ loudness:0,dynamics:0,pitch:0,zeroCrossing:0,pauseRatio:1,tempoVariation:0 }); emotion.value = { ...current, label, explanation: `已手动选择「${label}」标签。` }; cover.value = { ...coverPresetFor(label), title: cover.value.title || label }; }
  function goCover() { stage.value = 'cover'; }
  async function save(target?: HTMLCanvasElement) {
    // 连续点击/并发调用：一次保存未结束前直接忽略
    if (saving.value) return;
    const audio = draft.audio; const emotionSnapshot = emotion.value; const featuresSnapshot = features.value;
    if (!audio || !emotionSnapshot || !featuresSnapshot) { error.value = '作品信息尚未完整，请先完成声音分析'; return; }
    // 在第一个 await 之前同步抓取快照：图片、声音、名称、分析依据必须同属这一次保存，
    // 保存期间界面虽然已锁定，快照仍保证渲染与写入不被任何响应式变化拆开
    const title = draft.title.trim() || '未命名声音';
    const coverSnapshot: CoverConfig = { ...cover.value, palette: [...cover.value.palette] as [string, string, string] };
    const savedFeatures: AudioFeatures = { ...featuresSnapshot };
    const id = draft.id ?? `meme-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = draft.createdAt ?? new Date().toISOString();
    const duration = draft.duration;
    saving.value = true; error.value = '';
    let written: VoiceMeme | undefined;
    try {
      const coverBlob = await deps.renderer.render(coverSnapshot, target);
      written = { id, title, emotion: emotionSnapshot.label, confidence: emotionSnapshot.confidence, features: savedFeatures, audio, duration, cover: coverBlob, coverConfig: coverSnapshot, createdAt };
      await deps.repository.save(written);
    } catch {
      // 写入或渲染失败：停留封面页，完整保留可重试内容（含声音与分析依据）
      saving.value = false;
      error.value = '保存失败，本次编辑内容仍保留，请检查浏览器存储空间后重试。';
      return;
    }
    // 写入已确认落库：回写 id/时间，随后再刷新列表与切页；
    // 列表刷新失败不能反过来报“保存失败”，否则会诱导重复保存
    draft.id = id; draft.createdAt = createdAt;
    saving.value = false;
    stage.value = 'collection'; notice.value = '作品已保存到本地';
    await loadCollection();
  }
  async function loadCollection() {
    try { collection.value = (await deps.repository.list()).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); collectionError.value = ''; }
    catch { collectionError.value = '作品列表刷新失败，作品已保存在本机，可重试刷新。'; }
  }
  function editMeme(meme: VoiceMeme) { Object.assign(draft, { id:meme.id,title:meme.title,audio:meme.audio,duration:meme.duration,cropStart:0,cropEnd:meme.duration,createdAt:meme.createdAt }); features.value = { ...meme.features }; emotion.value = { label:meme.emotion,confidence:meme.confidence,explanation:'编辑已保存作品',scores:{'暴躁老哥':0,'温柔姐姐':0,'阴阳怪气':0,'元气满满':0} }; cover.value = { ...meme.coverConfig, palette: [...meme.coverConfig.palette] }; stage.value = 'cover'; error.value=''; collectionError.value=''; }
  async function deleteMeme(id: string) { await deps.repository.delete(id); await loadCollection(); }
  async function shareMeme(meme: VoiceMeme) { const result = await deps.share.share(meme); notice.value = result === 'shared' ? '已打开系统分享' : '浏览器不支持文件分享，已下载音频和封面'; }
  function newRecording() { draft.id = undefined; draft.title = '我的声音表情'; draft.audio = undefined; draft.createdAt = undefined; emotion.value = undefined; features.value = undefined; stage.value = 'record'; error.value = ''; }
  return { stage,error,notice,level,draft,emotion,features,cover,collection,saving,collectionError,startRecording,stopRecording,importAudio,analyze,selectEmotion,goCover,save,loadCollection,editMeme,deleteMeme,shareMeme,newRecording };
}
