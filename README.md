Servidor Multijugador Web 2D
Servidor backend de alto rendimiento para un juego de navegador multijugador 2D en tiempo real. Construido en Node.js puro con WebSockets, utiliza compresión binaria extrema y comunicación Peer-to-Peer para garantizar una latencia casi nula.

Características Principales
Motor Multijugador de Baja Latencia: Sincronización en tiempo real de movimiento, físicas y combate usando WebSockets puros (ws).
Compresión Binaria: Serialización de todos los paquetes de red mediante MessagePack, reduciendo dramáticamente el consumo de ancho de banda frente a JSON tradicional.
Voice Chat P2P (WebRTC): Chat de voz táctico por escuadrones (Clanes). El servidor actúa únicamente como enrutador de señalización (Signaling Server), permitiendo conexiones directas de navegador a navegador sin consumir CPU ni ancho de banda del servidor.
Sistema de Cuentas y Progresión: Persistencia de datos en MongoDB. Gestión de autenticación, Elo (Rankeds), Battle Pass, inventarios y misiones diarias.
Clanes y Bases: Creación de Squads, captura de Bases (Turf) y persistencia del mapa físico.
Seguridad: Sistema robusto Anti-Spam/DDoS y protección contra ataques por inyección de paquetes. Comandos administrativos integrados (Freeze, Jail, Teleport, Kicks).

Tecnologías Utilizadas
Entorno: Node.js
Redes y Tiempo Real: ws (WebSockets), WebRTC, MessagePack
Base de Datos: MongoDB + Mongoose
Seguridad y Autenticación: bcryptjs
Pagos/Tienda: Stripe API
Frontend (Cliente): HTML5 Canvas, Vanilla JavaScript
