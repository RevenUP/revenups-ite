document.querySelectorAll('tr[data-href]').forEach((tr) => {
  tr.addEventListener('click', () => {
    window.location.href = tr.getAttribute('data-href');
  });
});
