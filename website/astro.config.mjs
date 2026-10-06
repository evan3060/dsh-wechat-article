// @ts-check
import { defineConfig } from 'astro/config';

// GitHub Pages 项目站：https://evan3060.github.io/dsh-wechat-article/
// base 是项目站子路径（用户名仓库页）；若日后绑自定义域名，去掉 base 即可。
export default defineConfig({
  site: 'https://evan3060.github.io',
  base: '/dsh-wechat-article/',
});
