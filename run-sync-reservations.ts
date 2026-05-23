import { syncInventoryReservations } from './server/syncReservations';

async function main() {
  console.log('Iniciando sincronização de reservas...');
  const result = await syncInventoryReservations();
  console.log('Resultado:', JSON.stringify(result, null, 2));
}

main().catch(console.error);
