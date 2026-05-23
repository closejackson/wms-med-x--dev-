/**
 * PortalClientUsersSection.tsx
 *
 * Seção para gerenciar usuários do Portal do Cliente (systemUsers).
 * Exibe todos os usuários (aprovados, pendentes, rejeitados) com ações de:
 * - Aprovar / Rejeitar solicitações pendentes
 * - Redefinir senha (força nova senha no próximo login)
 */

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { CheckCircle2, XCircle, Clock, UserCheck, KeyRound, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

export function PortalClientUsersSection() {
  const [approveDialogOpen, setApproveDialogOpen] = useState(false);
  const [resetPasswordDialogOpen, setResetPasswordDialogOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<any>(null);
  const [selectedTenantId, setSelectedTenantId] = useState<string>("");

  const utils = trpc.useUtils();

  // Queries
  const { data: allUsers, isLoading } = trpc.clientPortal.listAllPortalUsers.useQuery();
  const { data: tenants } = trpc.tenants.list.useQuery();

  // Mutations
  const approveMutation = trpc.clientPortal.approveUser.useMutation({
    onSuccess: () => {
      toast.success("Usuário aprovado com sucesso!");
      utils.clientPortal.listAllPortalUsers.invalidate();
      setApproveDialogOpen(false);
      setSelectedUser(null);
      setSelectedTenantId("");
    },
    onError: (error) => {
      toast.error(error.message || "Erro ao aprovar usuário");
    },
  });

  const rejectMutation = trpc.clientPortal.rejectUser.useMutation({
    onSuccess: () => {
      toast.success("Solicitação rejeitada");
      utils.clientPortal.listAllPortalUsers.invalidate();
    },
    onError: (error) => {
      toast.error(error.message || "Erro ao rejeitar usuário");
    },
  });

  const resetPasswordMutation = trpc.clientPortal.requestPasswordReset.useMutation({
    onSuccess: () => {
      toast.success("Redefinição de senha solicitada. O usuário deverá criar nova senha no próximo login.");
      utils.clientPortal.listAllPortalUsers.invalidate();
      setResetPasswordDialogOpen(false);
      setSelectedUser(null);
    },
    onError: (error) => {
      toast.error(error.message || "Erro ao solicitar redefinição de senha");
    },
  });

  const handleApprove = (user: any) => {
    setSelectedUser(user);
    setSelectedTenantId(user.tenantId?.toString() ?? "");
    setApproveDialogOpen(true);
  };

  const handleConfirmApprove = () => {
    if (!selectedUser || !selectedTenantId) {
      toast.error("Selecione um cliente para atribuir ao usuário");
      return;
    }
    approveMutation.mutate({
      userId: selectedUser.id,
      tenantId: parseInt(selectedTenantId),
    });
  };

  const handleReject = (user: any) => {
    if (confirm(`Tem certeza que deseja rejeitar a solicitação de ${user.fullName}?`)) {
      rejectMutation.mutate({ userId: user.id });
    }
  };

  const handleResetPassword = (user: any) => {
    setSelectedUser(user);
    setResetPasswordDialogOpen(true);
  };

  const handleConfirmResetPassword = () => {
    if (!selectedUser) return;
    resetPasswordMutation.mutate({ userId: selectedUser.id });
  };

  const getStatusBadge = (status: string, mustReset?: boolean | null) => {
    if (mustReset) {
      return (
        <Badge variant="outline" className="bg-orange-50 text-orange-700 border-orange-300">
          <AlertTriangle className="w-3 h-3 mr-1" />
          Redefinição pendente
        </Badge>
      );
    }
    switch (status) {
      case "pending":
        return (
          <Badge variant="outline" className="bg-yellow-50 text-yellow-700 border-yellow-300">
            <Clock className="w-3 h-3 mr-1" />
            Pendente
          </Badge>
        );
      case "approved":
        return (
          <Badge variant="outline" className="bg-green-50 text-green-700 border-green-300">
            <CheckCircle2 className="w-3 h-3 mr-1" />
            Aprovado
          </Badge>
        );
      case "rejected":
        return (
          <Badge variant="outline" className="bg-red-50 text-red-700 border-red-300">
            <XCircle className="w-3 h-3 mr-1" />
            Rejeitado
          </Badge>
        );
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const pendingCount = allUsers?.filter((u) => u.approvalStatus === "pending").length ?? 0;

  return (
    <div className="container mx-auto px-6 pb-8">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <UserCheck className="w-5 h-5 text-blue-600" />
                Usuários do Portal do Cliente
              </CardTitle>
              <CardDescription className="mt-1">
                Gerencie os acessos ao Portal do Cliente — aprovações, rejeições e redefinição de senha
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {pendingCount > 0 && (
                <Badge variant="outline" className="bg-yellow-100 text-yellow-800 border-yellow-300 text-sm px-3 py-1">
                  {pendingCount} {pendingCount === 1 ? "pendente" : "pendentes"}
                </Badge>
              )}
              <Badge variant="outline" className="text-sm px-3 py-1">
                {allUsers?.length ?? 0} usuário(s)
              </Badge>
            </div>
          </div>
        </CardHeader>

        <CardContent>
          {isLoading ? (
            <div className="text-center py-8">
              <p className="text-sm text-gray-600">Carregando usuários do portal...</p>
            </div>
          ) : !allUsers || allUsers.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <UserCheck className="w-10 h-10 mx-auto mb-2 opacity-30" />
              <p className="text-sm">Nenhum usuário do portal cadastrado</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>E-mail</TableHead>
                  <TableHead>Login</TableHead>
                  <TableHead>Cliente</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Último Acesso</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {allUsers.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell className="font-medium">{user.fullName}</TableCell>
                    <TableCell className="text-gray-600 text-sm">{user.email}</TableCell>
                    <TableCell className="font-mono text-sm text-gray-600">{user.login}</TableCell>
                    <TableCell className="text-sm">
                      {user.clientName !== "—" ? (
                        <span className="text-gray-800">{user.clientName}</span>
                      ) : (
                        <span className="text-gray-400 italic">Não atribuído</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {getStatusBadge(user.approvalStatus, user.mustResetPassword)}
                    </TableCell>
                    <TableCell className="text-gray-600 text-sm">
                      {user.lastLogin
                        ? new Date(user.lastLogin).toLocaleString("pt-BR")
                        : <span className="text-gray-400 italic">Nunca</span>}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        {user.approvalStatus === "pending" && (
                          <>
                            <Button
                              size="sm"
                              onClick={() => handleApprove(user)}
                              className="bg-green-600 hover:bg-green-700 text-white"
                              disabled={approveMutation.isPending}
                            >
                              <CheckCircle2 className="w-3 h-3 mr-1" />
                              Aprovar
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleReject(user)}
                              className="border-red-300 text-red-600 hover:bg-red-50"
                              disabled={rejectMutation.isPending}
                            >
                              <XCircle className="w-3 h-3 mr-1" />
                              Rejeitar
                            </Button>
                          </>
                        )}
                        {user.approvalStatus === "approved" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleResetPassword(user)}
                            className="border-orange-300 text-orange-600 hover:bg-orange-50"
                            disabled={resetPasswordMutation.isPending}
                          >
                            <KeyRound className="w-3 h-3 mr-1" />
                            Redefinir Senha
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Approve Dialog */}
      <Dialog open={approveDialogOpen} onOpenChange={setApproveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Aprovar Acesso ao Portal</DialogTitle>
            <DialogDescription>
              Atribua um cliente ao usuário <strong>{selectedUser?.fullName}</strong> para liberar o acesso
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="tenant">Cliente (Tenant) *</Label>
              <Select value={selectedTenantId} onValueChange={setSelectedTenantId}>
                <SelectTrigger id="tenant">
                  <SelectValue placeholder="Selecione o cliente" />
                </SelectTrigger>
                <SelectContent>
                  {tenants?.map((tenant) => (
                    <SelectItem key={tenant.id} value={tenant.id.toString()}>
                      {tenant.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-gray-500">O usuário terá acesso apenas aos dados deste cliente</p>
            </div>
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <p className="text-sm text-blue-800 font-medium">Informações do Usuário:</p>
              <ul className="mt-2 space-y-1 text-sm text-blue-700">
                <li>• Nome: {selectedUser?.fullName}</li>
                <li>• E-mail: {selectedUser?.email}</li>
                <li>• Login: {selectedUser?.login}</li>
              </ul>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="bg-white/10 text-white border-white/30 hover:bg-white/20 hover:text-white" onClick={() => { setApproveDialogOpen(false); setSelectedUser(null); setSelectedTenantId(""); }}>
              Cancelar
            </Button>
            <Button
              onClick={handleConfirmApprove}
              disabled={!selectedTenantId || approveMutation.isPending}
              className="bg-green-600 hover:bg-green-700"
            >
              {approveMutation.isPending ? "Aprovando..." : "Aprovar Acesso"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset Password Confirmation */}
      <AlertDialog open={resetPasswordDialogOpen} onOpenChange={setResetPasswordDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <KeyRound className="w-5 h-5 text-orange-500" />
              Redefinir Senha do Usuário
            </AlertDialogTitle>
            <AlertDialogDescription>
              O usuário <strong>{selectedUser?.fullName}</strong> ({selectedUser?.email}) será obrigado a criar uma nova senha no próximo login ao Portal do Cliente.
              <br /><br />
              Esta ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={resetPasswordMutation.isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmResetPassword}
              disabled={resetPasswordMutation.isPending}
              className="bg-orange-600 hover:bg-orange-700"
            >
              {resetPasswordMutation.isPending ? "Processando..." : "Confirmar Redefinição"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
