import { useLocation } from "wouter";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Warehouse, Home } from "lucide-react";

export default function Inventory() {
  const [, setLocation] = useLocation();

  return (
    <div className="min-h-screen">
      <PageHeader
        icon={<Warehouse className="h-8 w-8" />}
        title="Estoque"
        description="Controle e rastreabilidade de inventário"
        actions={
          <Button variant="outline" className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white" onClick={() => setLocation("/home")}>
            <Home className="h-4 w-4 mr-2" />
            Início
          </Button>
        }
      />
      <main className="container mx-auto px-6 py-8">
        <div className="text-center py-16 text-white/70">Módulo em desenvolvimento</div>
      </main>
    </div>
  );
}
