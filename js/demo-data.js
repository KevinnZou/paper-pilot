// 演示数据：一键填充示例论文（题目/大纲/草稿/文献/打卡/素材），用于课程演示与体验
// 注意：载入会覆盖当前本地数据（调用方需先确认）
import { saveProject, getProject, hasActiveProject, createProject } from './project.js';
import { get, set } from './storage.js';
import { ensureCitationIds } from './citation-utils.js';

const DAY = 86400000;

function iso(ms) {
  const t = new Date(ms);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

export function loadDemoData() {
  if (!hasActiveProject()) createProject({ title: '演示论文项目' });
  const due = new Date(Date.now() + 30 * DAY);
  const dueStr = iso(due.getTime());
  const chapters = ['第一章 绪论', '第二章 相关理论基础', '第三章 方法设计', '第四章 实验与结果分析', '第五章 总结与展望'];

  saveProject({
    title: '基于注意力机制的医学图像小样本分割研究',
    degreeType: '硕士论文',
    dueDate: dueStr,
    outline: chapters.map(c => ({ chapter: c })),
    chapterProgress: {
      '第一章 绪论': '已完成',
      '第二章 相关理论基础': '进行中',
      '第三章 方法设计': '进行中',
      '第四章 实验与结果分析': '未开始',
      '第五章 总结与展望': '未开始',
    },
    currentChapter: '第二章 相关理论基础',
    abstract: '医学图像分割是计算机辅助诊断的基础任务，但高质量标注数据稀缺限制了深度学习方法的性能。本文围绕小样本场景下的医学图像分割问题，构建基于注意力机制的少样本分割框架，并在公开医学影像数据集上验证其有效性。',
    keywords: '医学图像分割；小样本学习；注意力机制；深度学习',
    acknowledgments: '感谢导师在选题与研究方法上的悉心指导，感谢课题组同学在实验数据整理中的帮助。',
    materials: [
      { id: 'demo-m1', type: '📄 摘要', title: '第二章 相关理论基础', content: '本章梳理了注意力机制与少样本学习的理论基础……', createdAt: '2026/8/16 21:30' },
    ],
  });

  const drafts = {};
  drafts['第一章 绪论'] = {
    content: '医学图像分割旨在从医学影像中自动提取感兴趣区域，是辅助诊断与治疗规划的关键步骤。近年来，基于深度学习的图像分割方法取得了显著进展，但其性能高度依赖于大规模像素级标注数据。\n\n在临床实践中，医学图像的标注需要经验丰富的医生投入大量时间，导致高质量标注数据稀缺。因此，研究在少量标注样本条件下保持分割性能的方法，具有重要的理论意义与应用价值。\n\n本文围绕小样本医学图像分割问题，研究注意力机制在少样本学习框架中的作用，并设计相应的分割网络与评估实验。',
    updatedAt: Date.now() - DAY,
  };
  drafts['第二章 相关理论基础'] = {
    content: '注意力机制通过对特征图的不同区域赋予差异化权重，使网络聚焦于关键信息[1]。在医学图像分割任务中，注意力模块被广泛用于增强病灶区域的响应。\n\n少样本学习旨在利用少量标注样本快速适应新任务。基于原型网络的方法通过计算支持集样本的特征原型，实现对新类别的分割[2]。',
    updatedAt: Date.now() - 3600000,
  };
  chapters.slice(2).forEach(c => { drafts[c] = { content: '', updatedAt: Date.now() }; });
  set('drafts', drafts);

  const demoCitations = ensureCitationIds([
    { litNo: 1, type: 'J', author: 'Vaswani A, Shazeer N, Parmar N, 等', title: 'Attention is all you need', source: 'Advances in Neural Information Processing Systems', year: '2017', vol: '30', formatted: 'Vaswani A, Shazeer N, Parmar N, 等. Attention is all you need[J]. Advances in Neural Information Processing Systems, 2017, 30.' },
    { litNo: 2, type: 'J', author: 'Snell J, Swersky K, Zemel R', title: 'Prototypical networks for few-shot learning', source: 'Advances in Neural Information Processing Systems', year: '2017', vol: '30', formatted: 'Snell J, Swersky K, Zemel R. Prototypical networks for few-shot learning[J]. Advances in Neural Information Processing Systems, 2017, 30.' },
    { litNo: 3, type: 'J', author: 'Ronneberger O, Fischer P, Brox T', title: 'U-Net: Convolutional networks for biomedical image segmentation', source: 'Medical Image Computing and Computer-Assisted Intervention', year: '2015', vol: '', formatted: 'Ronneberger O, Fischer P, Brox T. U-Net: Convolutional networks for biomedical image segmentation[J]. Medical Image Computing and Computer-Assisted Intervention, 2015.' },
  ]).list;
  set('citations', demoCitations);

  set('checkins', [
    { date: iso(Date.now()), chapter: '第二章 相关理论基础', note: '完成注意力机制小节，约900字' },
    { date: iso(Date.now() - DAY), chapter: '第一章 绪论', note: '绪论收尾，约1200字' },
    { date: iso(Date.now() - 2 * DAY), chapter: '第一章 绪论', note: '' },
  ]);
}

/** 是否存在任何已保存的用户数据（用于提示覆盖风险） */
export function hasExistingData() {
  return !!(getProject().title || Object.keys(get('drafts', {})).length || get('citations', []).length);
}
