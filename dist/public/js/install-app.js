(() => {
  const cfg = window.KHADAMAT_APP || {};
  let deferredPrompt = null;
  const label = cfg.label || 'تطبيق خدمات';
  const key = `khadamat-install-dismissed-${cfg.id || 'app'}`;

  function addButton() {
    if (document.getElementById('khadamat-install-button')) return;
    const btn = document.createElement('button');
    btn.id = 'khadamat-install-button';
    btn.type = 'button';
    btn.textContent = `تثبيت ${label}`;
    Object.assign(btn.style, {
      position:'fixed', bottom:'18px', left:'18px', zIndex:'99999',
      border:'0', borderRadius:'16px', padding:'13px 18px',
      font:'700 14px system-ui, sans-serif', color:'#fff',
      background:'linear-gradient(135deg,#5b3df5,#2878ff)',
      boxShadow:'0 10px 28px rgba(0,0,0,.22)', cursor:'pointer'
    });
    btn.onclick = async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      btn.remove();
    };
    document.body.appendChild(btn);
  }

  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
    addButton();
  });
  window.addEventListener('appinstalled', () => document.getElementById('khadamat-install-button')?.remove());
})();
