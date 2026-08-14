#!/bin/bash
# =============================================================================
# Neo4j Setup Script for Radarist Studio
# Phase 5: GraphRAG Reasoning Engine
# =============================================================================
#
# This script:
#   1. Starts Neo4j via Docker Compose
#   2. Waits for Neo4j to be healthy
#   3. Initializes the schema (constraints, indexes, relation types)
#
# Usage:
#   ./scripts/setup-neo4j.sh          # Start and initialize
#   ./scripts/setup-neo4j.sh up       # Start container only
#   ./scripts/setup-neo4j.sh stop     # Stop Neo4j
#   ./scripts/setup-neo4j.sh reset    # Stop, delete data, restart
#   ./scripts/setup-neo4j.sh status   # Check status
#   ./scripts/setup-neo4j.sh logs     # View logs
#
# =============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Configuration. Every process that touches Neo4j reads the same project-local
# environment file; the script deliberately does not source or echo its values.
ENV_FILE="$PROJECT_DIR/.env.local"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.neo4j.yml"
MAX_WAIT_SECONDS=120
COMPOSE_COMMAND=()

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Radarist Neo4j Setup - Phase 5: GraphRAG${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Change to project directory
cd "$PROJECT_DIR"

if [ ! -f "$ENV_FILE" ]; then
    echo -e "${RED}Error: .env.local not found. Run 'npm run setup:local' before starting Neo4j.${NC}"
    exit 1
fi

# Prefer the Compose v2 Docker CLI plugin. Keep the standalone executable as a
# compatibility fallback for older Docker Desktop installations.
resolve_compose_command() {
    if docker compose version > /dev/null 2>&1; then
        COMPOSE_COMMAND=(docker compose)
        return 0
    fi

    if command -v docker-compose > /dev/null 2>&1; then
        COMPOSE_COMMAND=(docker-compose)
        return 0
    fi

    echo -e "${RED}Error: Docker Compose is unavailable. Install the Docker Compose v2 plugin or docker-compose.${NC}"
    exit 1
}

# Keep every Compose action on the same explicit environment/config boundary.
compose() {
    if [ ${#COMPOSE_COMMAND[@]} -eq 0 ]; then
        resolve_compose_command
    fi
    "${COMPOSE_COMMAND[@]}" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

# Function to check if Docker is running
check_docker() {
    if ! docker info > /dev/null 2>&1; then
        echo -e "${RED}Error: Docker is not running. Please start Docker first.${NC}"
        exit 1
    fi
}

# Function to check Neo4j health
check_neo4j_health() {
    curl -s -o /dev/null -w "%{http_code}" http://localhost:7474 2>/dev/null || echo "000"
}

# Function to wait for Neo4j to be ready
wait_for_neo4j() {
    echo -e "${YELLOW}Waiting for Neo4j to be ready...${NC}"

    local elapsed=0
    while [ $elapsed -lt $MAX_WAIT_SECONDS ]; do
        local status=$(check_neo4j_health)
        if [ "$status" = "200" ]; then
            echo -e "${GREEN}Neo4j is ready!${NC}"
            return 0
        fi

        echo -n "."
        sleep 2
        elapsed=$((elapsed + 2))
    done

    echo ""
    echo -e "${RED}Error: Neo4j did not become ready within ${MAX_WAIT_SECONDS} seconds${NC}"
    return 1
}

# Function to initialize schema
initialize_schema() {
    echo -e "${YELLOW}Initializing Neo4j schema...${NC}"

    # Run the TypeScript initialization script
    # init-neo4j-schema.ts is the canonical, committed schema initializer
    # (creates the current v2 schema: :Assertion, not the deprecated :Claim).
    if [ ! -f "scripts/init-neo4j-schema.ts" ]; then
        echo -e "${RED}scripts/init-neo4j-schema.ts not found — cannot initialize the Neo4j schema.${NC}"
        exit 1
    fi
    node --env-file="$ENV_FILE" --import tsx scripts/init-neo4j-schema.ts

    echo -e "${GREEN}Schema initialized successfully!${NC}"
}

# Function to start the container without waiting or initializing the schema.
start_container() {
    echo -e "${YELLOW}Starting Neo4j...${NC}"

    check_docker

    if ! [ -f "$COMPOSE_FILE" ]; then
        echo -e "${RED}Error: $COMPOSE_FILE not found${NC}"
        exit 1
    fi

    compose up -d
}

# Function to start Neo4j and initialize its schema.
start_neo4j() {
    start_container

    wait_for_neo4j

    initialize_schema

    echo ""
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}  Neo4j is ready!${NC}"
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo -e "  ${BLUE}Browser UI:${NC}  http://localhost:7474"
    echo -e "  ${BLUE}Bolt URI:${NC}    bolt://localhost:7687"
    echo -e "  ${BLUE}Username:${NC}    neo4j"
    echo -e "  ${BLUE}Password:${NC}    configured in .env.local (not displayed)"
    echo ""
    echo -e "  ${YELLOW}Test connection:${NC}"
    echo -e "    npm run neo4j:health"
    echo ""
}

# Function to stop Neo4j
stop_neo4j() {
    echo -e "${YELLOW}Stopping Neo4j...${NC}"
    compose down
    echo -e "${GREEN}Neo4j stopped.${NC}"
}

# Function to reset Neo4j (delete all data)
reset_neo4j() {
    echo -e "${RED}WARNING: This will delete all Neo4j data!${NC}"
    if ! read -p "Are you sure? (y/N) " -n 1 -r; then
        echo
        echo "Cancelled. No Neo4j data was changed."
        return 1
    fi
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${YELLOW}Resetting Neo4j...${NC}"
        compose down -v
        start_neo4j
    else
        echo "Cancelled."
    fi
}

# Function to show status
show_status() {
    echo -e "${YELLOW}Neo4j Status:${NC}"
    echo ""

    local status=$(check_neo4j_health)
    if [ "$status" = "200" ]; then
        echo -e "  Health: ${GREEN}Healthy${NC}"
    else
        echo -e "  Health: ${RED}Not responding${NC}"
    fi

    echo ""
    compose ps 2>/dev/null || echo "  Container not running"
}

# Function to show logs
show_logs() {
    compose logs -f
}

# Main command handler
case "${1:-start}" in
    start)
        start_neo4j
        ;;
    up)
        start_container
        ;;
    stop)
        stop_neo4j
        ;;
    reset)
        reset_neo4j
        ;;
    status)
        show_status
        ;;
    logs)
        show_logs
        ;;
    restart)
        stop_neo4j
        start_neo4j
        ;;
    *)
        echo "Usage: $0 {start|up|stop|reset|status|logs|restart}"
        exit 1
        ;;
esac
