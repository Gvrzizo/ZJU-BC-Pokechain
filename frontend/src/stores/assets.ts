import { defineStore } from 'pinia';
import { getAssetManifest } from '@/api/assets';
import type { AssetManifestEntry } from '@/types';

// 资源状态：manifest 拉取结果 + vendor 覆盖情况（供 BootScene 与调试展示）
export const useAssetsStore = defineStore('assets', {
  state: () => ({
    manifest: [] as AssetManifestEntry[],
    manifestError: '',
    loadedFromVendor: {} as Record<string, boolean>,
    placeholderKeys: [] as string[],
    ready: false,
  }),
  actions: {
    async fetchManifest() {
      try {
        this.manifest = await getAssetManifest();
        this.manifestError = '';
      } catch (e) {
        // 后端未启动时静默降级：全部使用占位贴图
        this.manifest = [];
        this.manifestError = 'manifest 不可用，使用占位贴图';
      }
    },
    markVendor(key: string) {
      this.loadedFromVendor[key] = true;
    },
    markPlaceholder(key: string) {
      if (!this.placeholderKeys.includes(key)) this.placeholderKeys.push(key);
    },
    setReady() {
      this.ready = true;
    },
  },
});
