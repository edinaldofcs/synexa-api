import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { PainelClientsService } from './painel-clients.service';
import { CreatePainelClientDto } from './dto/create-painel-client.dto';
import { UpdatePainelClientDto } from './dto/update-painel-client.dto';
import { CreatePainelAgentDto } from './dto/create-painel-agent.dto';
import { UpdatePainelAgentDto } from './dto/update-painel-agent.dto';
import { CreatePainelIntentionDto } from './dto/create-painel-intention.dto';
import { UpdatePainelIntentionDto } from './dto/update-painel-intention.dto';
import { CreatePainelApiDto } from './dto/create-painel-api.dto';
import { UpdatePainelApiDto } from './dto/update-painel-api.dto';

@Controller('painel-clients')
export class PainelClientsController {
    constructor(private readonly painelClientsService: PainelClientsService) { }

    @Post()
    create(@Body() createPainelClientDto: CreatePainelClientDto) {
        return this.painelClientsService.create(createPainelClientDto);
    }

    @Get()
    findAll() {
        return this.painelClientsService.findAll();
    }

    @Get(':id')
    findOne(@Param('id') id: string) {
        return this.painelClientsService.findOne(id);
    }

    @Patch(':id')
    update(@Param('id') id: string, @Body() updatePainelClientDto: UpdatePainelClientDto) {
        return this.painelClientsService.update(id, updatePainelClientDto);
    }

    @Delete(':id')
    remove(@Param('id') id: string) {
        return this.painelClientsService.remove(id);
    }

    @Post(':id/duplicate')
    duplicate(@Param('id') id: string) {
        return this.painelClientsService.duplicateClient(id);
    }

    // --- Agents ---

    @Post('agents')
    createAgent(@Body() createDto: CreatePainelAgentDto) {
        return this.painelClientsService.createAgent(createDto);
    }

    @Get(':clientId/agents')
    findAllAgents(@Param('clientId') clientId: string) {
        return this.painelClientsService.findAllAgents(clientId);
    }

    @Get('agents/:id')
    findOneAgent(@Param('id') id: string) {
        return this.painelClientsService.findOneAgent(id);
    }

    @Patch('agents/:id')
    updateAgent(@Param('id') id: string, @Body() updateDto: UpdatePainelAgentDto) {
        return this.painelClientsService.updateAgent(id, updateDto);
    }

    @Delete('agents/:id')
    removeAgent(@Param('id') id: string) {
        return this.painelClientsService.removeAgent(id);
    }

    // --- Intentions ---

    @Post('intentions')
    createIntention(@Body() createDto: CreatePainelIntentionDto) {
        return this.painelClientsService.createIntention(createDto);
    }

    @Get(':clientId/intentions')
    findAllIntentions(@Param('clientId') clientId: string) {
        return this.painelClientsService.findAllIntentions(clientId);
    }

    @Get('intentions/:id')
    findOneIntention(@Param('id') id: string) {
        return this.painelClientsService.findOneIntention(id);
    }

    @Patch('intentions/:id')
    updateIntention(@Param('id') id: string, @Body() updateDto: UpdatePainelIntentionDto) {
        return this.painelClientsService.updateIntention(id, updateDto);
    }

    @Delete('intentions/:id')
    removeIntention(@Param('id') id: string) {
        return this.painelClientsService.removeIntention(id);
    }

    // --- APIs ---

    @Post('apis')
    createApi(@Body() createDto: CreatePainelApiDto) {
        return this.painelClientsService.createApi(createDto);
    }

    @Get(':clientId/apis')
    findAllApisByClient(@Param('clientId') clientId: string) {
        return this.painelClientsService.findAllApisByClient(clientId);
    }

    @Get('apis/:id')
    findOneApi(@Param('id') id: string) {
        return this.painelClientsService.findOneApi(id);
    }

    @Patch('apis/:id')
    updateApi(@Param('id') id: string, @Body() updateDto: UpdatePainelApiDto) {
        return this.painelClientsService.updateApi(id, updateDto);
    }

    @Delete('apis/:id')
    removeApi(@Param('id') id: string) {
        return this.painelClientsService.removeApi(id);
    }
}
