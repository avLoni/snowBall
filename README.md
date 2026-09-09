# Bolas de Neve — instalação

Há duas partes, e podem viver no mesmo sítio ou separadas.

| parte | o que é | precisa de |
|---|---|---|
| **ficheiros** | as páginas, o céu, os modelos | qualquer alojamento com HTTPS — o teu cPanel serve |
| **relay** | pontuações e o painel de controlo | Node.js a correr, com WebSockets |

Se não quiseres o painel de controlo nem a tabela partilhada, **só precisas
da primeira**. O jogo funciona sozinho, com a tabela guardada no próprio
dispositivo.

## Endereços

| endereço   | para quem |
|------------|-----------|
| `/`        | os jogadores (o hub) |
| `/control` | o tablet do operador |
| `/watch`   | ecrã de espectador |
| `/logs`    | **as gravações feitas dentro dos óculos**, para descarregar no PC |
| `/scores`  | a tabela, em JSON |

### Tirar dados de dentro dos óculos

Copiar texto de um Vision Pro para outro computador é penoso, por isso o
laboratório de arremesso envia a gravação sozinho ao sair da sessão. Depois,
no computador, abre `/logs`, e cada sessão tem um botão para descarregar e
outro para copiar.

As gravações vão também para a pasta `gravacoes/` e sobrevivem a um reinício
do processo — mas **não a uma nova publicação**, que no Render recria o
disco. Descarrega-as no mesmo dia.

---

## Opção A — tudo no mesmo servidor (mais simples)

Publica esta pasta inteira como aplicação Node. O servidor serve as páginas
*e* o relay, e o jogo encontra-o sozinho, sem configuração nenhuma.

    npm install
    npm start

- `/` é o hub, para os jogadores
- `/control` é o painel, para o tablet do operador

## Opção B — ficheiros no cPanel, relay à parte

Usa o `snowball-cpanel.zip` para os ficheiros e esta pasta para o relay.
Depois **abre o `snowball.html` e o `snowball_mobile.html` e preenche uma
linha**, perto do topo:

    const RELAY_OVERRIDE = 'https://o-teu-relay.onrender.com';

Sem isso o jogo procura o relay no cPanel, onde ele não está.

---

## Publicar o relay no Render

O Render **só publica a partir de um repositório Git** — não aceita ZIP.
Aceita GitHub, GitLab ou Bitbucket, e para repositórios públicos nem é
preciso ligar conta nenhuma: basta colar o endereço do repositório.

1. Cria um repositório (GitHub, GitLab ou Bitbucket) com esta pasta.
2. Render → **New → Web Service** → aponta ao repositório.
   - Runtime: **Node**
   - Build: `npm install`
   - Start: `npm start`
3. Guarda o endereço que o Render te dá.

### Se não quiseres mesmo usar Git

Há plataformas que publicam a partir da pasta local, sem repositório:

- **Fly.io** — `flyctl launch` e depois `flyctl deploy`, tudo do terminal
- **Railway** — `railway up`, envia a pasta como está

Ambas correm Node com WebSockets e têm escalão gratuito.

### O aviso que interessa no Render

No plano gratuito o serviço **adormece ao fim de 15 minutos** sem tráfego e
demora perto de um minuto a acordar. Numa sessão ao vivo isso é fatal: a
criança está com os óculos postos e não acontece nada. O painel de controlo
mantém o serviço desperto enquanto estiver aberto, mas para um evento a
sério vale o escalão pago mais baixo.

A tabela de pontuações vive em memória e perde-se em cada reinício.

---

## Se o teu cPanel tiver "Setup Node.js App"

Muitos alojamentos com cPanel têm essa opção, e nesse caso podes correr
tudo no teu próprio servidor, sem Render. Vale a pena verificares.

O senão: os WebSockets nem sempre passam pelo Passenger, que é o que o
cPanel usa. Se o painel de controlo ligar e cair logo a seguir, é isso — e
a saída é uma das plataformas acima.

## Depois de cada publicação

Sobe o `BUILD` no `hub.html`. O Safari do visionOS guarda ficheiros em cache
com persistência, e o número novo obriga-o a ir buscá-los outra vez.
