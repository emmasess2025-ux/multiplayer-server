const mongoose = require('mongoose');

const squadMemberSchema = new mongoose.Schema({
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    customTitle: { type: String, default: 'Miembro' }, // Aquí va "Comandante", "Reclutador", etc.

    // Los permisos granulares que pediste
    canInvite: { type: Boolean, default: false },      // Puede contratar personal
    canKick: { type: Boolean, default: false },        // Puede sacar personal
    canAssignRoles: { type: Boolean, default: false },  // Puede dar atributos a otros (Full Admin)
    joinedAt: { type: Date, default: Date.now }        // Anti-cheat para recompensas de clan
}, { _id: false }); // _id: false evita que MongoDB le cree un ID extra a cada fila del arreglo

// El esquema principal del Squad
const squadSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        unique: true, // ¡Garantiza que no haya dos nombres iguales!
        maxLength: 20 // Para que el nombre no ocupe toda la pantalla
    },
    leader: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    // 👇 NUEVO CAMPO PARA EL LOGO 👇
    logo: { type: String, default: "" },
    // Arreglo de miembros (Excluyendo al líder). Controlaremos el límite de 24 en el código.
    members: [squadMemberSchema],

    createdAt: { type: Date, default: Date.now },
    // 👇 NUEVO: CAMPO PARA EL RANKING GLOBAL DE INFAMIA 👇
    territoryTimeMinutes: { type: Number, default: 0 },
    // 👇 NUEVOS CAMPOS PARA LOS RANKINGS ROTATIVOS 👇
    dailyTimeMinutes: { type: Number, default: 0 },
    weeklyTimeMinutes: { type: Number, default: 0 },
    // NUEVO: SEGUIMIENTO DE CUANDO SE ALCANZAN LAS METAS (ANTI-CHEAT)
    milestonesAchieved: { type: Map, of: Date, default: {} }
});

const Squad = mongoose.model('Squad', squadSchema);

module.exports = Squad;
