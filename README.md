# Desafio Spacecom 2027

Algoritmo em TypeScript para detectar encontros entre usuários de tornozeleira eletrônica e vítimas com medidas protetivas a partir dos arquivos de geolocalização do desafio.

O processamento compara somente posições com **timestamp idêntico**. A distância é calculada pela fórmula de Haversine, com raio terrestre de **6.371.000 metros**, e deve ser **estritamente menor que 20 metros**.

## Como executar

Requer Node.js 22.18 ou superior e npm. Na pasta do projeto:

```sh
npm ci
npm run compilar
node compilado/codigo/terminal.js --entrada arquivo.txt --saida encontros.json
```

Para executar os datasets oficiais, salve os arquivos TXT dos links do enunciado em uma pasta chamada `entradas`, com os nomes `dataset1.txt` a `dataset7.txt`.

```sh
# Processar um dataset
node compilado/codigo/terminal.js --arquivo 1

# Processar todos os datasets disponíveis
node compilado/codigo/terminal.js --todos
```

Os resultados são gravados em `saidas/encontrosN.json`. No modo `--todos`, arquivos ausentes são informados e os presentes são processados em sequência. Se nenhum estiver disponível, a execução falha. Os TXT de entrada devem ser obtidos pelos links fornecidos no enunciado.

O código-fonte está em `codigo`. A compilação gera a pasta `compilado`. O pacote contém o código, os testes, as configurações de compilação, este README e os sete JSONs de resultado.

Para rodar os testes automatizados: `npm run testar`.

### Parâmetros

| Opção | Uso |
| --- | --- |
| `--entrada TXT --saida JSON` | Informar os caminhos de entrada e saída |
| `--arquivo N` | Processar o dataset de 1 a 7. Aceita `--saida` para alterar o destino |
| `--todos` | Processar os datasets presentes |
| `--pasta-entradas DIR`, `--pasta-saidas DIR` | Alterar os diretórios padrão `entradas` e `saidas` |
| `--estrategia forca-bruta\|grade\|adaptativa` | Escolher a estratégia. O padrão é `adaptativa` |
| `--limiar N` | Máximo de usuários para a busca direta adaptativa. Padrão 4.096 |
| `--ordem automatica\|ordenada\|externa` | Detectar e tratar desordem, exigir ordem ou ordenar externamente desde o início |
| `--registros-por-lote N` | Máximo de registros por lote de ordenação externa. Padrão 50.000 |
| `--maximo-por-grupo N` | Máximo de IDs únicos por timestamp. Padrão 250.000 |
| `--ajuda` | Exibir a ajuda |

A execução retorna 0 em caso de sucesso, 1 em falhas de processamento e 2 em erros de argumentos. As métricas são escritas em `stderr`, separadas do JSON de resultado.

## Formato dos dados

O arquivo de entrada é UTF-8, separado por ponto e vírgula, com sete campos nesta ordem:

```text
idMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida
```

O ID identifica a pessoa. Facção vazia indica ausência dessa informação. O campo `medidaProtetiva=true` identifica uma vítima, enquanto `false` identifica um usuário de tornozeleira. As restrições contêm os IDs dos agressores vinculados, separados por vírgula, como `"10,25"`.

O timestamp usa `YYYY-MM-DD HH:MM:SS`. Seu valor é preservado, sem conversão de fuso, arredondamento ou interpolação. A cadência de cinco segundos descreve a geração dos dados. Posições de instantes diferentes não são comparadas.

Cada resultado contém os campos exigidos no enunciado. Por exemplo, este encontro do dataset 1:

```json
[{
  "tipo": "generico",
  "monitoradosEncontro": [4, 6],
  "timestamp": "2024-01-01 00:05:15",
  "posicoes": {
    "4": { "lat": -31.93195, "lon": -40.61438 },
    "6": { "lat": -31.93187, "lon": -40.61435 }
  },
  "distanciaMetros": 9.33522817789823
}]
```

## Lógica do algoritmo

### 1. Ler e reunir as posições do mesmo instante

O leitor percorre o TXT em blocos de 1 MiB lidos como bytes e interpreta cada linha diretamente no `Buffer`, sem criar strings intermediárias ([leitura-rapida.ts](codigo/arquivos/leitura-rapida.ts)). Esse caminho rápido reconhece o formato canônico dos datasets: IDs decimais sem zeros à esquerda, timestamp com ou sem aspas, coordenadas decimais simples e restrições vazias ou em lista, com ou sem aspas. Coordenadas com até 15 dígitos são convertidas como mantissa inteira dividida por uma potência de 10. As duas grandezas são exatas em `double`, então o resultado é igual a `Number(texto)`. O último timestamp validado fica memorizado, pois registros consecutivos costumam repeti-lo.

Qualquer linha fora desse formato (zeros à esquerda, mais de 15 dígitos, valores fora da faixa, campos inválidos, UTF-8 inválido, entre outros) é entregue ao parser completo de [interpretacao.ts](codigo/arquivos/interpretacao.ts), que aplica todas as validações e produz as mesmas mensagens de erro de antes. As posições são entregues em lotes ao agrupador, que mantém um `Map` por ID para o timestamp corrente.

Ao mudar de timestamp, o grupo completo é enviado ao detector. Depois de processado, suas estruturas podem ser liberadas. Assim, a memória de trabalho depende do maior grupo e dos buffers de leitura e escrita, em vez de crescer com todas as linhas do arquivo.

Os sete datasets foram inspecionados e estão ordenados por timestamp. A aplicação verifica essa propriedade em cada execução. No modo automático, uma regressão temporal descarta a saída provisória e inicia uma ordenação externa, relendo a entrada. Essa ordenação usa lotes de até 50.000 registros ou aproximadamente 32 MiB serializados e intercala até 32 arquivos por etapa. Isso permite reunir corretamente os instantes mesmo quando aparecem separados no TXT.

### 2. Selecionar os pares elegíveis

| Pessoas envolvidas no mesmo timestamp | Classificação |
| --- | --- |
| Dois usuários da mesma facção não vazia | `faccao` |
| Demais pares de usuários de tornozeleira | `generico` |
| Vítima e usuário listado nas restrições dela | `protetiva` |

A classificação de facção tem precedência sobre a genérica, conforme os gabaritos. Duas facções vazias não demonstram pertencimento à mesma facção. Duas vítimas, uma vítima próxima de pessoa sem vínculo ou um ID sem posição naquele instante não geram encontro.

Para usuários de tornozeleira, cada par é avaliado uma única vez, seja pela varredura em latitude (grupos pequenos) ou pela grade espacial (grupos grandes). Para vítimas, o detector consulta diretamente os IDs vinculados em um `Map` do grupo. Uma vítima com dois agressores presentes exige duas verificações de distância, sem examinar todos os outros participantes.

### 3. Descartar pares distantes antes da Haversine

Nos grupos pequenos, o detector usa uma **varredura em latitude** (*sweep line*). Uma separação norte–sul já estabelece uma distância mínima entre os pontos, qualquer que seja sua diferença de longitude. Por isso, ordenar os usuários por latitude permite examinar, para cada um, apenas os vizinhos cuja latitude difere em até **0,00018°**, equivalentes a aproximadamente **20,015 m** no raio especificado. A varredura para no primeiro vizinho acima desse valor, pois todos os seguintes estão ainda mais distantes.

Essa folga evita usar uma aproximação exatamente sobre a fronteira de 20 m. Todos os pares dentro da janela ainda precisam ser confirmados com Haversine, então o conjunto de pares avaliados é o mesmo do laço direto com o mesmo filtro. Só deixam de ser percorridos os pares que o filtro já descartaria.

Os encontros de cada grupo são reordenados pelos índices originais antes de serem emitidos. Assim, a saída fica na mesma ordem de uma comparação par a par, o que permite verificar a otimização por hash.

Esse passo custa `O(m log m + k)` para `m` usuários e `k` pares dentro da janela, em vez dos `m(m−1)/2` pares do laço direto.

### 4. Confirmar a distância e emitir o encontro

Com latitudes e longitudes convertidas para radianos, o cálculo utiliza:

```text
a = sin²(Δφ/2) + cos(φ₁) · cos(φ₂) · sin²(Δλ/2)
d = 2 · R · atan2(√a, √(1−a))

R = 6.371.000 metros
φ = latitude
λ = longitude
```

O intermediário `a` é limitado a [0, 1] para evitar uma raiz inválida por arredondamento próximo aos antípodas. A decisão usa a distância completa, com a condição `d < 20`. Portanto, 19,99 m pode ser aceito e 20 m exatos são rejeitados.

Os IDs são gravados em ordem crescente, com as coordenadas dos registros originais. Um encontro só é emitido uma vez por par e timestamp.

## Por que foi escolhida a estratégia adaptativa

Os arquivos oficiais têm milhões de linhas, mas só entre 10 e 120 pessoas por timestamp, e apenas posições com o mesmo timestamp são comparadas. Isso define a escolha:

- **O problema é de muitos grupos pequenos, não de um grupo enorme.** Com cerca de 100 pessoas por instante, estruturas espaciais pesadas custam mais para montar do que economizam. Medido no motor, a grade foi mais lenta que a busca direta nesses grupos.
- **O custo dominante é ler e interpretar o arquivo.** Com 21,5 milhões de registros, o perfil de CPU mostrou que a leitura e o parsing eram cerca de 87% do tempo. Por isso o maior ganho veio do parser de bytes, e não de uma estrutura de busca mais sofisticada.
- **A varredura em latitude é a menor mudança que evita pares distantes.** Ela usa só uma ordenação e uma comparação, sem converter coordenadas, e reaproveita a mesma regra de descarte já provada, com folga sobre os 20 m. Isso mantém a saída idêntica à referência.
- **Cada encontro protetivo é consultado por vínculo explícito.** A vítima só é comparada com os agressores listados, sem varrer os outros participantes.
- **A grade 3D fica como proteção para grupos grandes.** Se um arquivo futuro tiver milhares de pessoas por instante, a varredura em latitude degeneraria para quadrática quando muitos compartilham a faixa de latitude. A grade ECEF mantém a vizinhança uniforme, inclusive em polos e no antimeridiano.
- **Corretude acima de velocidade.** A pontuação é `soma_ec − soma_ei`, então um falso positivo ou uma omissão custam mais que alguns segundos. Toda otimização foi aceita só com as sete saídas idênticas, por hash, às de uma versão já comparada com a força bruta e com os gabaritos.

Foram implementadas e comparadas três estratégias:

| Estratégia | Vantagem | Custo ou limitação |
| --- | --- | --- |
| Força bruta | É simples de conferir e serve de referência para as otimizações | Calcula Haversine para todo par elegível |
| Grade espacial ECEF | Reduz os candidatos em grupos grandes e dispersos | Exige conversão de coordenadas, criação de células e consultas de vizinhança |
| Adaptativa | Usa varredura em latitude nos grupos pequenos e grade nos maiores, com consulta protetiva por ID | O ponto de troca depende dos dados e da máquina |

Na amostra dos primeiros 20 grupos do dataset 7, a mediana por grupo foi **0,3249 ms para força bruta**, **0,4260 ms para grade** e **0,0269 ms para a adaptativa** (medida antes da varredura em latitude, com laço direto e filtro). A medição comparou somente o motor, com aquecimento e cinco repetições por configuração. Nessa amostra, a grade economizou distâncias, mas seu custo de organização foi maior que o da busca direta.

O limiar de **4.096 usuários** foi definido a partir de cenários sintéticos dispersos. Com 2.048 usuários, a busca direta mediu 6,28 ms contra 8,43 ms da grade. Com 8.192, foram 111,94 ms contra 54,42 ms. Em 4.096, a ordem variou entre rodadas, por isso o corte é configurável. Todos os grupos oficiais usaram o caminho direto.

### Grade espacial

Acima do limiar, latitude e longitude são convertidas para coordenadas cartesianas sobre a mesma esfera:

```text
x = R · cos(φ) · cos(λ)
y = R · cos(φ) · sin(λ)
z = R · sin(φ)
```

Os pontos são indexados em cubos de **20,000001 m**. A distância em linha reta entre duas posições da esfera não supera o arco entre elas. Se o arco é menor que 20 m, a diferença em cada eixo também é menor que 20 m. Portanto, em aritmética real, basta buscar na própria célula e nas 26 vizinhas.

A margem de um micrômetro pertence apenas ao índice. A aceitação continua dependendo da Haversine estritamente abaixo de 20 m. Essa margem considera o arredondamento usual do Node/V8, mas JavaScript não especifica um limite universal de erro para todas as funções trigonométricas. A grade foi comparada à referência também em polos, antimeridiano e posições próximas da fronteira.

### Memória, complexidade e dependências

Para `g` pessoas, `m` usuários de tornozeleira, `r` restrições e `k` pares dentro da janela de latitude no grupo, o processamento direto custa `O(g + m log m + k + r)`. No pior caso, com todos na mesma faixa de latitude, `k` chega a `m²`. Na grade, o custo esperado depende das posições, das restrições e dos candidatos retornados. O pior caso continua quadrático quando muitas pessoas estão no mesmo local e todos os encontros precisam ser emitidos.

A leitura em blocos reduz suspensões assíncronas por registro. A escrita incremental evita acumular todos os encontros na memória. A ordenação externa acrescenta leitura, escrita e espaço temporário em disco quando a entrada está desordenada.

Carregar o TXT inteiro ou manter todos os timestamps em um mapa faria a memória crescer com o arquivo. O processamento por grupo evita esse custo nos dados ordenados. Uma grade em latitude/longitude precisaria de cuidados específicos com graus, latitude, polos e antimeridiano. A conversão tridimensional mantém uma vizinhança uniforme.

TypeScript permite verificar os contratos em compilação. O motor usa somente módulos e estruturas nativas do Node.js, sem bibliotecas npm de produção. TypeScript 5.9.3 e os tipos do Node 22.18.0 ficam restritos ao desenvolvimento, com versões fixadas no lockfile. Não há necessidade de banco de dados ou servidor para esse processamento em lote.

## Segurança e integridade

Os arquivos são tratados como entradas não confiáveis.

- **Validação de conteúdo.** O parser exige o cabeçalho e sete campos, verifica aspas e escapes, IDs inteiros seguros, coordenadas finitas dentro das faixas geográficas, datas válidas e booleanos literais `true` ou `false`. UTF-8 inválido é rejeitado. Campos citados podem conter separadores, mas campos multilinha não são suportados.
- **Coerência dos registros.** Restrições repetidas são normalizadas. Autorrestrição, vítima com facção e restrições em pessoa sem medida protetiva são rejeitadas. Repetições equivalentes do mesmo ID e instante são deduplicadas. Posições ou metadados conflitantes interrompem o arquivo, sem escolher arbitrariamente um registro.
- **Limites de recursos.** Cada linha tem limite de 64 KiB. O agrupador admite por padrão até 250.000 IDs por timestamp e aplica um orçamento lógico de 64 MiB, estimado pelas posições e restrições. Esse orçamento não é um teto de memória do processo, pois o runtime e as estruturas acrescentam consumo.
- **Proteção de caminhos.** A entrada deve ser um arquivo regular. A aplicação resolve caminhos e rejeita saída igual à entrada, links simbólicos de saída e hardlinks para a entrada.
- **Publicação do resultado.** A saída é escrita em arquivo temporário exclusivo no mesmo diretório. Após concluir o array, o arquivo é sincronizado, fechado e renomeado. Uma falha anterior à publicação preserva a saída existente. Bloqueios do sistema de arquivos podem impedir a substituição e são tratados como erro.
- **Execução local.** Os dados não são executados como código. O processamento não usa `eval`, comandos de shell a partir da entrada, chamadas externas ou telemetria. As falhas normais têm mensagens resumidas, sem imprimir os registros completos ou a pilha de execução.

Os diretórios e a entrada devem permanecer sob controle do operador durante a execução. A checagem de caminhos não impede alterações concorrentes por outro processo. Uma interrupção abrupta pode deixar temporários, e a sincronização do arquivo não oferece garantia completa contra perda de energia. Os JSONs contêm coordenadas por exigência do contrato.

## Resultados e verificação

Foram processados **21.530.020 registros**, com **118 encontros**.

| Dataset | Registros | Encontros | Saída |
| --- | ---: | ---: | --- |
| 1 | 5.000 | 4 | [encontros1.json](saidas/encontros1.json) |
| 2 | 25.000 | 6 | [encontros2.json](saidas/encontros2.json) |
| 3 | 100.000 | 10 | [encontros3.json](saidas/encontros3.json) |
| 4 | 400.020 | 15 | [encontros4.json](saidas/encontros4.json) |
| 5 | 1.000.000 | 21 | [encontros5.json](saidas/encontros5.json) |
| 6 | 8.000.000 | 27 | [encontros6.json](saidas/encontros6.json) |
| 7 | 12.000.000 | 35 | [encontros7.json](saidas/encontros7.json) |

Os datasets 1 e 2 foram comparados com os gabaritos após a otimização da leitura, em quantidade, tipo, par, timestamp e coordenadas: 4 de 4 e 6 de 6 encontros corretos, sem falsos positivos nem omissões. O maior desvio observado nas distâncias foi de aproximadamente 1,8 × 10⁻¹⁵ m. A tolerância da comparação foi de 10⁻⁷ m e não altera o limite da detecção.

Os sete arquivos foram comparados integralmente com a força bruta. No dataset 7, a referência calculou **633.500.000 Haversines** e a adaptativa calculou **706.250**, com os mesmos 35 encontros. A referência compartilha a fórmula e parte das regras de domínio, mas não usa o filtro espacial ou a consulta protetiva otimizada. Os gabaritos complementam essa verificação com uma resposta externa. Os datasets 3 a 7 não possuem gabarito disponibilizado.

A suíte automatizada (`npm run testar`, 10 testes com o executor nativo `node:test`) cobre:

- o limite de 20 m: abaixo aceita, a partir de 20 m rejeita;
- a classificação em `faccao`, `generico` e `protetiva`, e a ausência de encontro entre vítimas ou sem vínculo;
- a recusa de timestamps diferentes;
- a equivalência da estratégia adaptativa e da grade com a força bruta, em 300 grupos densos aleatórios com pares próximos da fronteira de 20 m;
- a ordem de emissão da varredura em latitude, igual à do laço par a par;
- polos e antimeridiano;
- a equivalência do parser de bytes com o parser completo, em linhas válidas, inválidas e 20.000 linhas aleatórias;
- a leitura em blocos com CRLF, sem quebra de linha final e atravessando fronteiras de bloco;
- a rejeição de cabeçalho inválido, arquivo vazio e UTF-8 inválido.

Ordenação externa, grupos acima do limite de memória e preservação da saída em falhas não têm testes automatizados nesta suíte.

### Desempenho observado

As medições foram realizadas em Windows x64, Intel Core i5-13450HX, aproximadamente 15,69 GiB de RAM e Node.js 22.18.0.

O tempo somado dos sete arquivos caiu de cerca de **41 s** na versão original para uma **mediana de 10,1 s** (cerca de 75% a menos), medida em 5 rodadas completas com a máquina ociosa. O parser de bytes levou o total a cerca de 11,6 s e a varredura em latitude, a cerca de 9 a 10 s. A leitura, que representava cerca de 87% do tempo, caiu para cerca de 69% do total.

Mediana, mínimo e máximo de 5 rodadas na versão atual:

| Dataset | Mediana (ms) | Mín (ms) | Máx (ms) |
| --- | ---: | ---: | ---: |
| 1 | 46 | 26 | 52 |
| 2 | 34 | 32 | 60 |
| 3 | 58 | 52 | 73 |
| 4 | 194 | 176 | 305 |
| 5 | 490 | 424 | 530 |
| 6 | 3.740 | 3.401 | 3.872 |
| 7 | 5.386 | 5.124 | 6.240 |
| **Total** | **10.108** | **9.260** | **10.856** |

Evolução por etapa, em uma execução de cada versão:

| Dataset | Original (ms) | Parser de bytes (ms) | Parser + varredura (ms) |
| --- | ---: | ---: | ---: |
| 1 | 33 | 27 | 60 |
| 2 | 88 | 33 | 54 |
| 3 | 232 | 56 | 66 |
| 4 | 798 | 172 | 203 |
| 5 | 2.034 | 481 | 458 |
| 6 | 15.083 | 4.264 | 3.332 |
| 7 | 22.702 | 6.534 | 5.239 |
| **Total** | **40.970** | **11.567** | **9.413** |

Nos datasets 1 a 4 as diferenças são de poucas dezenas de milissegundos e ficam dentro da variação entre execuções. O ganho aparece nos datasets maiores. Execuções isoladas mostraram picos de até 19,9 s no total, causados por competição de recursos na máquina: ler o dataset 7 inteiro, sem nenhum código do projeto, leva menos de 0,5 s, e o processamento completo ficou estável entre 5,6 e 5,8 s em três rodadas seguidas. O tempo de CPU do processo é maior que o de relógio (cerca de 10 s contra 5,7 s no dataset 7), pois o coletor de lixo trabalha em paralelo: o código aloca muitos objetos de curta duração, e esse é o ponto que ainda poderia ser melhorado.

As sete saídas conservaram os mesmos bytes e hashes SHA-256 da versão original, portanto os encontros são exatamente os mesmos. O perfil de CPU antes das mudanças apontava a validação por expressões regulares, a análise do CSV e a criação de strings como os maiores custos. A varredura em latitude alterou a ordem de busca dos pares na detecção, mas não o conjunto de pares avaliados nem a ordem de emissão.

Medições anteriores, de uma versão intermediária da leitura: os sete arquivos passaram de **99,53 s para 69,85 s**, e a mediana do dataset 5 caiu de **5,08 s para 3,57 s**. O pico RSS amostrado foi de **99,76 MiB**, contra aproximadamente **79,66 MiB** antes dos lotes. Os lotes mantêm mais objetos temporariamente e a coleta de lixo afeta as amostras. Os tempos representam o ambiente medido e variam com carga da máquina, cache e sistema de arquivos.

## Código principal

| Arquivo | Responsabilidade |
| --- | --- |
| [codigo/terminal.ts](codigo/terminal.ts) | Receber e validar os argumentos |
| [codigo/processamento.ts](codigo/processamento.ts) | Coordenar leitura, agrupamento, detecção e gravação |
| [codigo/deteccao/motor.ts](codigo/deteccao/motor.ts) | Selecionar candidatos e emitir encontros |
| [codigo/dominio/classificacao.ts](codigo/dominio/classificacao.ts) | Aplicar as regras dos três tipos de encontro |
| [codigo/geografia/coordenadas.ts](codigo/geografia/coordenadas.ts) | Calcular Haversine e converter para ECEF |
| [codigo/geografia/grade.ts](codigo/geografia/grade.ts) | Indexar e consultar as células espaciais |
| [codigo/arquivos/leitura.ts](codigo/arquivos/leitura.ts) | Ler o TXT em blocos de bytes e montar os lotes de posições |
| [codigo/arquivos/leitura-rapida.ts](codigo/arquivos/leitura-rapida.ts) | Interpretar linhas canônicas direto no `Buffer`, com fallback ao parser completo |
| [codigo/arquivos/interpretacao.ts](codigo/arquivos/interpretacao.ts) | Validar o CSV e os campos |
| [codigo/arquivos/agrupamento.ts](codigo/arquivos/agrupamento.ts) | Agrupar timestamps, deduplicar e detectar conflitos |
| [codigo/arquivos/ordenacao-externa.ts](codigo/arquivos/ordenacao-externa.ts) | Ordenar entradas desordenadas com lotes em disco |
| [codigo/arquivos/escrita.ts](codigo/arquivos/escrita.ts) | Gravar o JSON e publicar o arquivo final |
| [codigo/dominio/tipos.ts](codigo/dominio/tipos.ts) | Definir os contratos das posições e dos encontros |
