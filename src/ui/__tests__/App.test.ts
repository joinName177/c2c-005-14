import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import App from '../App.vue';
import type { StudioDependencies } from '../useStudio';
import type { VoiceMeme } from '../../core/models';

function deps(options: { denied?: boolean } = {}): StudioDependencies {
  const works: VoiceMeme[] = [];
  return {
    recorder:{isRecording:false,start:async()=>{if(options.denied)throw new DOMException('denied','NotAllowedError')},stop:async()=>new Blob(['voice'],{type:'audio/webm'})},
    analyzer:{analyze:async()=>({duration:2,features:{loudness:.75,dynamics:.55,pitch:.8,zeroCrossing:.62,pauseRatio:.12,tempoVariation:.6}})},
    cropper:{inspect:async()=>({duration:2,needsCrop:false}),crop:async(blob,range)=>({blob,duration:range.end-range.start})},
    renderer:{render:async()=>new Blob(['cover'],{type:'image/png'})},
    repository:{list:async()=>works,save:async(m)=>{works.push(m)},rename:async()=>{},delete:async(id)=>{const i=works.findIndex(w=>w.id===id);if(i>=0)works.splice(i,1)}},
    share:{share:async()=> 'shared'},
  };
}

describe('Voice meme App', () => {
  it('shows the studio stages, time limit and sharing disclosure', () => {
    const wrapper = mount(App,{props:{dependencies:deps()}});
    expect(wrapper.text()).toContain('声音表情包工坊');
    expect(wrapper.text()).toContain('00:10 MAX');
    expect(wrapper.text()).toContain('分享链接不包含原始声音');
  });
  it('shows a recoverable microphone permission error', async () => {
    const wrapper=mount(App,{props:{dependencies:deps({denied:true})}}); await wrapper.get('[data-testid="record"]').trigger('click'); await Promise.resolve();
    expect(wrapper.text()).toContain('麦克风权限');
  });
  it('creates, labels, edits and saves a work to the gallery', async () => {
    const wrapper=mount(App,{props:{dependencies:deps()}}); await wrapper.get('[data-testid="record"]').trigger('click'); await wrapper.get('[data-testid="stop"]').trigger('click'); await Promise.resolve();
    await wrapper.get('[data-testid="analyze"]').trigger('click'); await Promise.resolve(); await wrapper.get('[data-emotion="温柔姐姐"]').trigger('click'); expect(wrapper.text()).toContain('已手动选择');
    await wrapper.get('[data-testid="to-cover"]').trigger('click'); await wrapper.get('[aria-label="气泡文字"]').setValue('轻轻说一句'); await wrapper.get('[data-testid="save-work"]').trigger('click'); await Promise.resolve(); await Promise.resolve();
    expect(wrapper.text()).toContain('作品集'); expect(wrapper.text()).toContain('我的声音表情');
  });
  it('locks cover editing while saving and ignores repeated clicks', async () => {
    let releaseRender: (() => void) | undefined; let saveCount = 0;
    const works: VoiceMeme[] = [];
    const wrapper=mount(App,{props:{dependencies:{...deps(),renderer:{render:async()=>new Promise<Blob>((resolve)=>{releaseRender=()=>resolve(new Blob(['cover'],{type:'image/png'}));})},repository:{list:async()=>works,save:async(m)=>{saveCount+=1;works.push(m)},rename:async()=>{},delete:async()=>{}}}}});
    await wrapper.get('[data-testid="record"]').trigger('click'); await wrapper.get('[data-testid="stop"]').trigger('click'); await Promise.resolve();
    await wrapper.get('[data-testid="analyze"]').trigger('click'); await Promise.resolve(); await Promise.resolve(); await wrapper.get('[data-emotion="温柔姐姐"]').trigger('click');
    await wrapper.get('[data-testid="to-cover"]').trigger('click'); await wrapper.get('[aria-label="气泡文字"]').setValue('保存中的文字');
    await wrapper.get('[data-testid="save-work"]').trigger('click'); await wrapper.vm.$nextTick(); await Promise.resolve();
    const button = wrapper.get('[data-testid="save-work"]').element as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect((wrapper.get('[aria-label="气泡文字"]').element as HTMLTextAreaElement).disabled).toBe(true);
    expect(wrapper.text()).toContain('正在保存');
    await wrapper.get('[data-testid="save-work"]').trigger('click');
    expect(saveCount).toBe(0);
    releaseRender!(); await Promise.resolve(); await Promise.resolve(); await wrapper.vm.$nextTick();
    expect(saveCount).toBe(1);
    expect(wrapper.text()).toContain('作品集');
  });
  it('retries the gallery refresh after a successful write without duplicating the work', async () => {
    let failList = false;
    const works: VoiceMeme[] = [];
    const wrapper=mount(App,{props:{dependencies:{...deps(),repository:{list:async()=>{if(failList)throw new Error('list down');return works},save:async(m)=>{works.push(m);failList=true},rename:async()=>{},delete:async()=>{}}}}});
    await wrapper.get('[data-testid="record"]').trigger('click'); await wrapper.get('[data-testid="stop"]').trigger('click'); await Promise.resolve();
    await wrapper.get('[data-testid="analyze"]').trigger('click'); await Promise.resolve(); await Promise.resolve(); await wrapper.get('[data-emotion="元气满满"]').trigger('click');
    await wrapper.get('[data-testid="to-cover"]').trigger('click'); await wrapper.get('[data-testid="save-work"]').trigger('click'); await Promise.resolve(); await Promise.resolve();
    expect(wrapper.text()).toContain('列表刷新失败');
    expect(works).toHaveLength(1);
    failList = false;
    await wrapper.get('[data-testid="retry-collection"]').trigger('click'); await Promise.resolve();
    expect(wrapper.text()).toContain('我的声音表情');
    expect(wrapper.text()).not.toContain('列表刷新失败');
    expect(works).toHaveLength(1);
  });
});
