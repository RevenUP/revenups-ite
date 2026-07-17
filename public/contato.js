const form = document.getElementById('form-contato');
const msg = document.getElementById('form-msg');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.className = 'form-msg';
  msg.textContent = '';

  const dados = {
    nome: form.nome.value.trim(),
    email: form.email.value.trim(),
    empresa: form.empresa.value.trim(),
    mensagem: form.mensagem.value.trim(),
  };

  const botao = form.querySelector('button');
  botao.disabled = true;
  botao.textContent = 'Enviando...';

  try {
    const resposta = await fetch('/api/contato', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dados),
    });

    const corpo = await resposta.json().catch(() => ({}));

    if (!resposta.ok) throw new Error(corpo.erro || 'Falha no envio');

    msg.textContent = 'Mensagem enviada. Em breve entraremos em contato.';
    msg.className = 'form-msg sucesso';
    form.reset();
  } catch (erro) {
    msg.textContent = erro.message || 'Não foi possível enviar agora. Tente novamente ou use o e-mail direto.';
    msg.className = 'form-msg erro';
  } finally {
    botao.disabled = false;
    botao.textContent = 'Enviar mensagem';
  }
});
