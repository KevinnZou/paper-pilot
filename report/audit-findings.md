# 上线前业务审计发现（4 域 subagent 全部返回）

## P1（上线前必须修）
- [ ] **✅P1-1 项目设置改题目不生效**：project-settings.js:112 只写 project.title；全站用 meaningfulTitle(design.title, project.title)（design 优先）→ 走完选题后改题无效。
- [ ] **✅P1-2 单项目导出备份不可导入**：projects.js:192 导出 {app,version,project}，settings.js:225/238 导入只认 {appState,projects}/{data} → 报“没有可识别的数据”。
- [ ] **✅P1-3 章节版本回退破坏结构+原子节点**（数据丢失）：writing.js:1812 createChapterSnapshot 用 textBetween（丢 atom）；:1844 restoreChapterVersion 用 insertText（抹平结构）。
- [ ] **✅P1-4 导出前检查读已保存态而非实时**：writing.js:2798 wb-export-check 用 docFromJSON({...getProject()})，导出用 viewState.doc → 防抖/流式时不一致。
- [ ] **✅P1-5 导出检查弹窗问题跳转失效**：writing.js:2829 只绑 [data-ec-close]，未绑 [data-issue-go]（check-export.js:322 有）→ “去对应章节/去文献库”点了模块不变、弹窗不关。
- [ ] **✅P1-6 gbt7714 issueBlock 卷期错拼**：gbt7714.js:13-18 `[volume,issue,pages].join(': ')` → "34: (3): 45-52"，应为 "34(3): 45-52"，波及所有 J/C 引用。

## P2（高价值，随 P1 一并修）
- [ ] **改截止日期后计划不重算**：project-settings.js:119 只改 dueDate；甘特图用旧 stages。
- [ ] **清除本地数据遗漏自学习**：settings.js:254 只删 paperpilot:*/thesismate:*，self-learning 键带 `.` 不匹配。
- [ ] **demo 数据载入后正文空**：demo-data.js 用 legacy set drafts/citations 未写 documentV2 → 编辑器读不到章体。
- [ ] **跳章后目录高亮不更新**：writing.js:2500 dispatchTransaction 只 syncCurrentChapter，未 renderOutline。
- [ ] **AI 建议接受用静态位置**：runSuggestion 捕获 pos，接受时未 tr.mapping。
- [ ] **跨项目引用污染**：writing.js:931 citationRestorePools 平铺 listProjects。
- [ ] **导出摘要总字数/引用数口径**：check-export.js:256 totalWords 只累加章节 drafts；:311 引用数=正文实际引用去重 ≠ 文献总数。
- [ ] **防抖保存窗口内切项目覆盖**：writing.js:2505 setTimeout(persistNow,500) 用全局 getProject()。
- [ ] **光标标题边界漂移**：sectionForPos 闭区间。
- [ ] **gbt7714 EB/OL 末尾双标点+顺序错**：gbt7714.js:28-29,49-51 → "https://x. [2024-01-01]."。
- [ ] **evidence 关联章节 label 解析**：citation.js:437,484 用 sectionId||chapter 存、用 sectionId 查 → 恒“已关联章节”。
- [ ] **dedupe 按规范化题名误删真实文献**：citation.js:389-410 同题名不同文献被静默删。
- [ ] **demo AI 批量解析必失败**：api.js mockGenericReply 匹配最后一条 user 消息，而解析指令在 system，demo 下 parse 报错。
- [ ] **计划时区**：任务 dueDate 用 UTC/today 本地错位；逾期同时进“今日”重复计数。
- [ ] **确认弹窗 outlineChapterCount 与 parseOutline 不一致**。
- [ ] **演示数据载入语义/英雄进度自相矛盾**：dashboard 研究设计1/6 vs 旅程已完成；heroAction else 死代码；focus CTA 双触发 data-nav+data-write（幂等）。

## 待修
Subagent 均未改码；视 P1 优先修复，P2 视机修。全站验证：0 溢出/0 报错。
