# LinguiPro 静读

把网页上的英文，排成一本好书。

选中一段英文，右键选择「用静读打开」（或按 <kbd>⌥⇧R</kbd>、点工具栏图标），原网页上会盖上一层阅读版式：
Literata 正文、舒展的行距、约 70 字符的行宽；超出你词汇量的生词被轻轻划出，释义写在页边，
文末附一张生词表。按 <kbd>Esc</kbd> 回到原网页。

## 安装

还没有上架应用商店，用开发者模式加载：

1. 打开 `chrome://extensions`，打开右上角「开发者模式」
2. 点「加载已解压的扩展程序」，选择本目录 `linguipro-reader/`
   （或者先 `npm run package` 生成 `dist/linguipro-reader-<版本>.zip`，解压后选择解压出的目录）
3. 安装后会自动打开欢迎页：选中页面上的示范段落，右键「用静读打开」试一下

需要 Chrome 120 或更新版本。

## 用法

| 想做什么 | 怎么做 |
|---|---|
| 打开阅读版式 | 选中文字 → 右键「用静读打开」；或 ⌥⇧R；或点工具栏图标 |
| 看生词释义 | 宽屏看右侧页边；把鼠标移到带下划线的词上看卡片；文末有完整生词表 |
| 查任意一个词 | 双击它（词库没有的词会现场机器翻译） |
| 不想再看到某个词 | 卡片或生词表里点「认识了」（可撤销；设置页可放回） |
| 调词汇量、字号、字体、背景 | 右上角 Aa |
| 只查一两个词 | 只选中这几个词再打开，直接弹出释义卡片 |

### 生词是怎么判定的

后端 `POST /api/words/glossary` 返回正文里每个词形的原形、词频排名 `rank`、考纲档位 `level`：

- 难度 = min(词频排名, 考纲档位)，大于你的词汇量就算生词；两者都没有的按最生僻处理
- 词频表是按词形排的（benefits 和 benefit 各有排名），所以取词形与原形候选里最靠前的排名
- 考纲档位来自词库标签：小学 700、初中 1600、高中 3500、四级 4500、考研 5500、六级 6000、雅思 7000、托福 8000、GRE 12000
- 专有名词（句中大写、括号里大写、全大写缩写）、代码标识符（Node.js、camelCase）、外文碎片、两字母词不算生词

### 语境释义

词典给的是一串义项，第一个未必是文中的意思（calculus 的首个义项是「[医]结石」）。生词整理好后，插件把
「生词 + 所在句子」一次交给 `POST /api/ai/reader-gloss`，由模型给出**在这句话里**的意思，旁注和卡片里标着「语境」。
每篇先问开头 40 个生词，读到后面再补问，最多 3 批；每批消耗 1 次 LinguiPro 的 AI 次数，用完当天自动改用词典释义。
可以在设置页关掉。

## 账号

不登录也能用：插件会以游客身份向后端要一个临时 token（15 分钟有效，过期自动续）。
在设置页登录 LinguiPro 账号后，会同步你在 LinguiPro 测出的词汇量，AI 次数也更多。

## 隐私

只在你用静读打开一段文字时，把其中的单词（开启语境释义时还有生词所在的句子）发送到 LinguiPro 服务器。
不读取、不上传浏览记录，也不发送你没有选中的内容。权限上只申请了 `activeTab`（在你点菜单/快捷键的那个标签页里临时生效），
没有「读取所有网站」的常驻权限。

## 开发

```
src/
  background.js      入口：右键菜单、快捷键、工具栏按钮 -> 抓选区 -> 盖阅读层
  capture.js         注入网页：遍历实时 DOM，把选区抓成结构化块（不传 HTML）
  overlay.js         注入网页：closed shadow root 里的全屏 iframe，关闭后原样恢复
  reader/            阅读页（排版、生词标注、旁注排布、生词表、释义卡片）
  options/           设置页兼欢迎页
  shared/            后端客户端、设置存储、纯文本逻辑
fonts/  icons/
tests/unit/          node --test 单测
tests/e2e/           Playwright：加载真实插件跑端到端
```

```bash
pnpm install
npm test                                 # 单测
npx playwright test reader               # 端到端（后端 mock）
LIVE=1 npx playwright test live          # 真实网站 + 线上后端（维基、PG、古腾堡、MDN、GitHub）
npm run icons                            # 重新生成图标
npm run package                          # 打包 zip
```

后端接口在 `english-learning-fastapi` 仓库：`app/services/glossary_service.py`、`app/routers/words.py`。
服务器地址默认 `https://json-view.org/english`，可在设置页「高级设置」里改。
