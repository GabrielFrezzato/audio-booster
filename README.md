# 🎚️ Audio Booster

Um console de reforço de áudio que roda inteiramente no navegador. Suba um arquivo de áudio (ou use o microfone), aumente o volume além de 100%, ajuste graves/médios/agudos e exporte o resultado em WAV — sem servidor, sem upload, sem instalar nada.

# Site github pages: https://gabrielfrezzato.github.io/audio-booster/

## ✨ Funcionalidades

- **Reforço de volume de 0% a 400%** usando um `GainNode` da Web Audio API, com leitura em % e em dB.
- **Equalizador de 3 bandas** (graves, médios, agudos) com filtros `BiquadFilter` (lowshelf / peaking / highshelf).
- **Limitador anti-clipping** opcional, baseado em `DynamicsCompressor`, para reforçar o volume sem estourar o áudio.
- **Forma de onda em tempo real** desenhada em `<canvas>`.
- **VU meters estéreo (L/R)** com indicador de pico e LED de clipping.
- **Duas fontes de entrada**: arquivo de áudio (MP3, WAV, OGG, M4A) ou microfone ao vivo.
- **Exportação em WAV** do áudio já reforçado, renderizada offline (`OfflineAudioContext`) — o download reflete exatamente os controles usados.
- Painel responsivo, com foco visível no teclado e respeito a `prefers-reduced-motion`.

## 🧱 Stack

Só o essencial — sem frameworks, sem bundler, sem `npm install`:

- **HTML5**
- **CSS3** (variáveis CSS, grid, sem bibliotecas)
- **JavaScript puro** (ES2020+) com a **Web Audio API**

Isso torna o projeto fácil de ler, fácil de rodar e fácil de hospedar em qualquer lugar estático, como o GitHub Pages.

## ▶️ Como rodar localmente

Não há build nem dependências. Duas formas de abrir:

1. **Direto no navegador**: dê duplo clique em `index.html`.
2. **Com um servidor local** (recomendado, evita restrições de alguns navegadores com `file://`):

   ```bash
   # Python
   python3 -m http.server 8080

   # ou Node
   npx serve .
   ```

   Depois acesse `http://localhost:8080`.

## 🔊 Como funciona (resumo técnico)

A cadeia de áudio conecta os nós da Web Audio API nesta ordem:

```
fonte → GainNode (reforço) → BiquadFilter (graves)
      → BiquadFilter (médios) → BiquadFilter (agudos)
      → DynamicsCompressor (limitador) → saída + analisadores
```

- O **reforço de volume** é só o `gain.value` do `GainNode` indo além de `1.0` (100%).
- O **limitador** evita que esse reforço distorça o som: quando ativado, comprime picos acima de -3 dB antes de chegar na saída.
- Os **VU meters** calculam o RMS do sinal em tempo real (via `AnalyserNode.getFloatTimeDomainData`) e o **LED de clipping** acende quando alguma amostra passa de ~0.98 de amplitude.
- Na **exportação**, a mesma cadeia é recriada em um `OfflineAudioContext` sobre o `AudioBuffer` decodificado do arquivo original, renderizada mais rápido que o tempo real, e o resultado é convertido manualmente para um arquivo `.wav` PCM 16-bit para download.

## 🖥️ Compatibilidade

Testado nos navegadores modernos baseados em Chromium, Firefox e Safari mais recentes (todos com suporte à Web Audio API). O acesso ao microfone exige HTTPS (ou `localhost`) por política do navegador.

## 📄 Licença

Distribuído sob a licença MIT — veja [LICENSE](LICENSE).
