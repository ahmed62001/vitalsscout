// Intentional demo pattern: synchronous late DOM insertion after first paint causing visible layout shift (CLS)
window.addEventListener('load', function () {
  var start = Date.now();
  while (Date.now() - start < 350) {}
  setTimeout(function () {
    var slot = document.getElementById('promo-slot');
    if (slot) {
      var div = document.createElement('div');
      div.className = 'late-promo';
      div.style.padding = '36px 16px';
      div.textContent = 'Free shipping on orders over $45 (injected late without reserved height — causes visible CLS shift)';
      slot.appendChild(div);
    }
  }, 600);
});
