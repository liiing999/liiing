# 无尽群岛 —— 运行方式

本项目使用 **ES Modules + importmap**，不能直接双击 `index.html`
（`file://` 协议会被浏览器 CORS 拦截），请用任意本地静态服务器打开。

## 方式一：Python（推荐，多数系统自带）

```bash
cd 项目目录
python -m http.server 8000
```

然后浏览器访问：<http://localhost:8000/>

## 方式二：Node.js

```bash
npx serve .
# 或
npx http-server -p 8000
```

访问提示的地址（通常是 <http://localhost:8000/> 或 <http://localhost:3000/>）。

## 网络说明

Three.js r160 通过 CDN（unpkg，版本号写死）加载，首次打开需要联网；
除此之外不依赖任何外部图片 / 模型 / 音频，所有纹理均为 Canvas 2D 实时生成。

建议使用桌面端最新版 Chrome / Edge / Firefox；移动端会提示“建议使用桌面浏览器”。
