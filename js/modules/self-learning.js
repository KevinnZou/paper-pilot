import { toast } from '../ui.js';
import { learningPageHtml, setPrefs, reset } from '../self-learning.js';

export default {
  id: 'self-learning',
  icon: '🧠',
  title: '个性化',
  subtitle: '系统学习你的写作习惯，并提供手动偏好调整',
  projectScoped: false,

  render(el) {
    el.innerHTML = `<div class="module-stack">${learningPageHtml()}</div>`;

    const tone = el.querySelector('#sl-tone');
    const intensity = el.querySelector('#sl-intensity');
    el.querySelector('#sl-save')?.addEventListener('click', () => {
      setPrefs({ tone: tone?.value, intensity: intensity?.value });
      toast('偏好已保存，将在后续 AI 建议中生效', 'ok');
    });
    el.querySelector('#sl-reset')?.addEventListener('click', () => {
      if (!confirm('确定清空已学到的交互记录吗？此操作不可恢复。')) return;
      reset();
      document.dispatchEvent(new CustomEvent('tm:navigate', { detail: 'self-learning' }));
      toast('已重置学习记录', 'ok');
    });
  },
};
